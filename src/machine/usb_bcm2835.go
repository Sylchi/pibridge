//go:build bcm2835 && !qemu

package machine

import (
	"runtime/volatile"
	"unsafe"
)

const (
	dwc2Base     = 0x20980000
	dwc2GRXSTSP  = dwc2Base + 0x020  // Receive Status Read and Pop
	dwc2DCTL     = dwc2Base + 0x704  // Device Control
	dwc2DIEPCTL0 = dwc2Base + 0x900  // EP0 IN Control
	dwc2DIEPTSIZ0 = dwc2Base + 0x910 // EP0 IN Transfer Size
	dwc2DIEPCTL1 = dwc2Base + 0x920  // EP1 IN Control
	dwc2DIEPTSIZ1 = dwc2Base + 0x930 // EP1 IN Transfer Size
	dwc2DTXFIFO0 = dwc2Base + 0x1000 // EP0 TX FIFO (also RX FIFO read)
	dwc2DTXFIFO1 = dwc2Base + 0x1100 // EP1 IN TX FIFO
	dwc2DOEPCTL0 = dwc2Base + 0xB00  // EP0 OUT Control
	dwc2DOEPTSIZ0 = dwc2Base + 0xB10 // EP0 OUT Transfer Size
	dwc2DOEP0SETUP0 = dwc2Base + 0xB18 // EP0 Setup Packet (lower 32 bits)
	dwc2DOEP0SETUP1 = dwc2Base + 0xB1C // EP0 Setup Packet (upper 32 bits)
)

// Packet status values from GRXSTSP (device mode)
const (
	dwcPktStsSetupRx      = 0x06 // Setup packet received
	dwcPktStsSetupDone    = 0x0C // Setup stage completed
	dwcPktStsOutDataRx    = 0x02 // OUT data packet received
	dwcPktStsOutDataDone  = 0x0C // OUT data transfer done
)

func dwc2Reg(addr uintptr) *volatile.Register32 {
	return (*volatile.Register32)(unsafe.Pointer(addr))
}

// USBProbe reads the DWC2 endpoint state without resetting the controller.
// Returns true if EP1 IN is configured and usable.
func USBProbe() bool {
	ctl := dwc2Reg(dwc2DIEPCTL1).Get()
	return (ctl & (1 << 15)) != 0 // USBACTEP bit
}

// USBSend sends up to 64 bytes on the existing EP1 bulk IN endpoint.
func USBSend(data []byte) {
	if len(data) == 0 {
		return
	}
	n := len(data)
	if n > 64 {
		n = 64
	}
	// Write to TX FIFO
	for i := 0; i < n; i += 4 {
		var w uint32
		if i < n {
			w |= uint32(data[i])
		}
		if i+1 < n {
			w |= uint32(data[i+1]) << 8
		}
		if i+2 < n {
			w |= uint32(data[i+2]) << 16
		}
		if i+3 < n {
			w |= uint32(data[i+3]) << 24
		}
		dwc2Reg(dwc2DTXFIFO1).Set(w)
	}
	// Set transfer size (PKTCNT=1, XFRSIZ=n)
	dwc2Reg(dwc2DIEPTSIZ1).Set((1 << 19) | uint32(n))
	// Enable endpoint: EPENA | CNAK (bit31 | bit28)
	// NOTE: bit30=EPDis (Endpoint Disable), NOT CNAK!
	dwc2Reg(dwc2DIEPCTL1).SetBits((1 << 31) | (1 << 28))
}

// USBSendString sends a string via USB bulk endpoint.
func USBSendString(s string) {
	USBSend([]byte(s))
}

// USBInitEP1IN configures EP1 as a BULK IN endpoint for serial backchannel.
func USBInitEP1IN() {
	// Check if EP1 IN is already active
	ctl := dwc2Reg(dwc2DIEPCTL1).Get()
	if ctl&(1<<15) != 0 {
		return // Already active
	}

	// Configure EP1 IN as BULK, MPS=64, TXFNUM=1
	val := uint32(0x40)            // MPS=64 (bits 0-10)
	val |= (2 << 18)               // EPTYP=Bulk (bits 18-19)
	val |= (1 << 22)               // TXFNUM=1 (bits 22-26)
	val |= (1 << 15)               // USBACTEP=1 (bit 15)
	val |= (1 << 29)               // SNAK=1 (bit 29, start with NAK)
	dwc2Reg(dwc2DIEPCTL1).Set(val)

	// Now set EPENA (bit 31)
	dwc2Reg(dwc2DIEPCTL1).SetBits(1 << 31)
}

// USBPoll checks for pending setup packets and responds.
// Must be called periodically from a goroutine.
func USBPoll() {
	// Read GRXSTSP to check for pending packets
	grxstsp := dwc2Reg(dwc2GRXSTSP).Get()
	if grxstsp == 0 {
		return
	}

	pktSts := (grxstsp >> 17) & 0x0F
	_ = pktSts

	if pktSts == dwcPktStsSetupRx || pktSts == dwcPktStsSetupDone {
		// Setup packet received on EP0.
		// Read the 8 bytes of setup data from DOEP0SETUP registers.
		lo := dwc2Reg(dwc2DOEP0SETUP0).Get()
		hi := dwc2Reg(dwc2DOEP0SETUP1).Get()

		bmRequestType := byte(lo)
		bRequest := byte(lo >> 8)
		wValue := uint16(lo >> 16)
		_ = wValue
		_ = uint16(hi)       // wIndex
		wLength := uint16(hi >> 16)

		// Handle rpiboot file server command read:
		// bmRequestType=0xC0 (device-to-host, vendor), bRequest=0, wLength=260
		if bmRequestType == 0xC0 && bRequest == 0 && wLength == 260 {
			// Respond with Done command (cmd=2)
			var resp [260]byte
			resp[0] = 2 // Done command

			// Write first 64 bytes to EP0 TX FIFO
			n := 64
			for i := 0; i < n; i += 4 {
				var w uint32
				if i < n {
					w |= uint32(resp[i])
				}
				if i+1 < n {
					w |= uint32(resp[i+1]) << 8
				}
				if i+2 < n {
					w |= uint32(resp[i+2]) << 16
				}
				if i+3 < n {
					w |= uint32(resp[i+3]) << 24
				}
				dwc2Reg(dwc2DTXFIFO0).Set(w)
			}

			// Set EP0 IN transfer size
			dwc2Reg(dwc2DIEPTSIZ0).Set((1 << 19) | uint32(n))
			// Enable EP0 IN (EPENA | CNAK)
			dwc2Reg(dwc2DIEPCTL0).SetBits((1 << 31) | (1 << 28))
		}
	}
}
