//go:build bcm2835 && !qemu

package main

import (
	"encoding/binary"
	"machine"
	"time"
)

// Pi Zero W BT power is on GPIO 45
const btPowerPin = machine.GPIO45

// BCM43438 HCI vendor command opcodes
const (
	ogfVendor = 0x3F

	ocfWriteRAM    = 0x4C // Write firmware data to chip RAM
	ocfLaunchRAM   = 0x4E // Boot loaded firmware
	ocfStartDownload = 0x2E // Enter download mode
)

func bcm43438VendorOpcode(ocf uint16) uint16 {
	return (ogfVendor << 10) | ocf
}

// btPowerOn sets GPIO 45 high to enable BT power on Pi Zero W
func btPowerOn() {
	pin := machine.GPIO45
	pin.Configure(machine.PinConfig{Mode: machine.PinOutput})
	pin.High()
	println("BT power ON (GPIO 45)")
	// Wait for chip to boot
	time.Sleep(200 * time.Millisecond)
}

// btSendRawHCICommand sends a raw HCI command via UART and waits for response.
// This bypasses the bluetooth package's HCI layer for firmware loading.
func btSendRawHCICommand(uart *machine.UART, opcode uint16, params []byte) error {
	// Build HCI command packet: type(1) + opcode(2) + len(1) + params(N)
	buf := make([]byte, 4+len(params))
	buf[0] = 0x01 // HCI Command Packet
	binary.LittleEndian.PutUint16(buf[1:], opcode)
	buf[3] = byte(len(params))
	copy(buf[4:], params)

	// Write to UART
	if _, err := uart.Write(buf); err != nil {
		return err
	}

	// Wait for Command Complete event
	// HCI UART event format on the wire:
	//   [HCI_type(1)] [event_code(1)] [param_len(1)] [params(N)]
	// where params = Num_Command_Packets(1) + Opcode(2) + Return_Params(M).
	// Total event size = 3 + param_len.
	// The minimum Command Complete (with Status return) is 7 bytes.
	timeout := time.Now().Add(3 * time.Second)
	for time.Now().Before(timeout) {
		if uart.Buffered() >= 7 { // Minimum event header + cmd complete
			// Read the event (including HCI packet type byte at index 0)
			evtBuf := make([]byte, 7)
			for i := 0; i < 7; i++ {
				b, err := uart.ReadByte()
				if err != nil {
					return err
				}
				evtBuf[i] = b
			}
			// Check if it's a Command Complete event (0x0E)
			// evtBuf[0] = HCI packet type (0x04), evtBuf[1] = event code
			if evtBuf[1] == 0x0E {
				// Check if opcode matches.
				// Layout: [type] [0x0E] [len] [NumPkts] [OpcodeLo] [OpcodeHi] [Status...]
				//          0      1      2       3         4          5         6
				// So opcode is at bytes 4-5 (little-endian).
				recvOpcode := binary.LittleEndian.Uint16(evtBuf[4:])
				if recvOpcode == opcode {
					// Read remaining bytes (param_len - 4 more bytes after the 7-byte header)
					evtLen := evtBuf[2]
					if int(evtLen) > 4 {
						remaining := int(evtLen) - 4
						for i := 0; i < remaining; i++ {
							uart.ReadByte()
						}
					}
					return nil
				}
			}
		}
		time.Sleep(1 * time.Millisecond)
	}
	return errHCITimeout
}

var errHCITimeout = &hciError{"HCI timeout"}

type hciError struct{ msg string }

func (e *hciError) Error() string { return e.msg }

// btLoadFirmware sends the BCM43438 firmware blob via HCI vendor commands.
// Must be called after btPowerOn() and before adapter.Enable().
func btLoadFirmware(uart *machine.UART) error {
	println("Loading BCM43438 firmware...")
	
	// Step 1: Send HCI Reset first (chip is in boot ROM)
	println("  HCI Reset...")
	if err := btSendRawHCICommand(uart, 0x0C03, nil); err != nil {
		println("  HCI Reset failed:", err.Error())
		// Try anyway - chip might not need reset
	}

	// Step 2: Enter download mode (Start Download)
	println("  Start download (0xFC2E)...")
	if err := btSendRawHCICommand(uart, bcm43438VendorOpcode(ocfStartDownload), nil); err != nil {
		println("  Start download failed:", err.Error())
		return err
	}
	
	time.Sleep(50 * time.Millisecond)

	// Step 3: Send firmware commands from blob
	fw := bcm43438Firmware
	pos := 0
	cmdCount := 0
	
	for pos < len(fw) {
		if pos+3 > len(fw) {
			break
		}
		opcode := binary.LittleEndian.Uint16(fw[pos:])
		plen := fw[pos+2]
		total := 3 + int(plen)
		
		if pos+total > len(fw) {
			break
		}
		
		params := fw[pos+3 : pos+total]
		
		if err := btSendRawHCICommand(uart, opcode, params); err != nil {
			println("  Firmware cmd", cmdCount, "failed:", err.Error())
			return err
		}
		
		pos += total
		cmdCount++
		
		// Progress every 20 commands
		if cmdCount%20 == 0 {
			println("  Firmware:", cmdCount, "/ 121 commands")
		}
	}
	
	println("  Firmware: all", cmdCount, "commands sent")
	
	// Step 4: Wait for firmware to boot
	time.Sleep(250 * time.Millisecond)
	
	println("BCM43438 firmware loaded")
	return nil
}
