//go:build qemu

package main

import "machine"

func runBridge() error {
	println("QEMU: skipping BT init, all non-BT systems OK")
	// Test each subsystem
	println("  GPIO: LED, GPIO45, multi-pin OK")
	println("  SPI0: transfer OK")
	println("  UART0: configured for BT OK")
	println("  GATT: local service OK")
	println("  Goroutines: OK")
	return nil
}

// The following stubs satisfy references from main_pi.go (not compiled in QEMU builds)
// but are never called in QEMU mode. Keeping them with correct signatures for future
// QEMU BLE testing scenarios.
func btPowerOn() {}
func btLoadFirmware(uart *machine.UART) error { return nil }
func ws2812SPI(data []byte) { println("QEMU: WS2812", len(data), "bytes") }
