//go:build qemu

package main

// initUSB is a no-op in QEMU (no DWC2 USB controller emulated).
func initUSB() {}

// usbPollLoop is a no-op in QEMU.
func usbPollLoop() {
	// No USB polling needed in QEMU.
}

// startUSBPoller launches the USB polling goroutine (no-op in QEMU).
func startUSBPoller() {
	go usbPollLoop()
}
