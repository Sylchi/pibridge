package main

import (
	"machine"
	"time"
	"tinygo.org/x/bluetooth"
)

var (
	adapter = bluetooth.DefaultAdapter
	chDo    bluetooth.Characteristic
	chPw    bluetooth.Characteristic
	chSv    bluetooth.Characteristic
	chWf    bluetooth.Characteristic
	chWm    bluetooth.Characteristic
	chAu    bluetooth.Characteristic
)

func main() {
	println("PiBridge v0.3")
	machine.LED.Configure(machine.PinConfig{Mode: machine.PinOutput})

	// Start USB setup packet handler goroutine
	// Responds to rpiboot file server commands with Done
	// Also handles USB re-enumeration for serial backchannel
	startUSBPoller()

	for i := 0; i < 3; i++ {
		machine.LED.Set(true)
		time.Sleep(100 * time.Millisecond)
		machine.LED.Set(false)
		time.Sleep(100 * time.Millisecond)
	}

	// Initialize USB endpoints for serial backchannel
	initUSB()

	err := runBridge()
	if err != nil {
		println("FAIL:", err.Error())
		for {
			machine.LED.Set(true)
			time.Sleep(50 * time.Millisecond)
			machine.LED.Set(false)
			time.Sleep(50 * time.Millisecond)
		}
	}

	println("PiBridge advertising!")
	for {
		machine.LED.Set(true)
		time.Sleep(1000 * time.Millisecond)
		machine.LED.Set(false)
		time.Sleep(1000 * time.Millisecond)
	}
}

// ---- USB (platform-specific) ----
// startUSBPoller and initUSB are defined in usb_pi.go (!qemu) and usb_qemu.go (qemu).

// ---- UUID helpers ----
func svcUUID() bluetooth.UUID {
	return bluetooth.NewUUID([16]byte{
		0x4d, 0x69, 0x72, 0x72, 0x6f, 0x72,
		0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	})
}

func charUUID(b byte) bluetooth.UUID {
	return bluetooth.NewUUID([16]byte{
		0x4d, 0x69, 0x72, 0x72, 0x6f, 0x72,
		0x00, b, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	})
}

// ---- Callbacks ----
func doCB(client bluetooth.Connection, offset int, value []byte) {
	if len(value) < 2 { return }
	pin := int(value[0])
	val := value[1] != 0
	machine.Pin(pin).Set(val)
	println("DO pin", pin, "=", val)
}

func pwCB(client bluetooth.Connection, offset int, value []byte) {
	if len(value) < 2 { return }
	println("PWM pin", int(value[0]), "val", value[1])
}

func svCB(client bluetooth.Connection, offset int, value []byte) {
	if len(value) < 2 { return }
	println("SERVO pin", int(value[0]), "angle", value[1])
}

func wfCB(client bluetooth.Connection, offset int, value []byte) {
	if len(value) < 3 { return }
	n := len(value) / 3
	println("WS2812 frame", n, "LEDs")
	ws2812SPI(value)
}

func wmCB(client bluetooth.Connection, offset int, value []byte) {
	println("WS2812 mode", len(value), "bytes")
}

func auCB(client bluetooth.Connection, offset int, value []byte) {
	println("Audio", len(value), "bytes")
}

// ---- Auto-watchdog reset (30s) ----
func init() {
	go func() {
		time.Sleep(30 * time.Second)
		println("Watchdog reset...")
		machine.WatchdogReset(100)
	}()
}
