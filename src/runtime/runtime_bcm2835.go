//go:build bcm2835 && !qemu

package runtime

// Mini UART (UART1) serial console + USB bulk output on real Pi Zero W hardware.
// GPIO 14/15 as ALT5 for Mini UART. USB output via DWC2 EP1 IN FIFO.

const (
	AUX_BASE    = 0x20215000
	AUX_ENABLES = AUX_BASE + 0x04
	AUX_MU_IO   = AUX_BASE + 0x40
	AUX_MU_IER  = AUX_BASE + 0x44
	AUX_MU_LCR  = AUX_BASE + 0x4C
	AUX_MU_LSR  = AUX_BASE + 0x54
	AUX_MU_CNTL = AUX_BASE + 0x60
	AUX_MU_BAUD = AUX_BASE + 0x68

	// DWC2 OTG registers for EP1 IN bulk data
	dwc2Base      = 0x20980000
	dwc2DIEPCTL1  = dwc2Base + 0x920
	dwc2DIEPTSIZ1 = dwc2Base + 0x930
	dwc2DTXFIFO1  = dwc2Base + 0x1100
)

var (
	uartDR  = reg32(AUX_MU_IO)
	uartLSR = reg32(AUX_MU_LSR)

	// USB output buffer
	usbBuf    [64]byte
	usbBufLen int
)

func putchar(c byte) {
	// Always send to Mini UART
	for (uartLSR.Get() & (1 << 5)) == 0 {}
	uartDR.Set(uint32(c))
	if c == '\n' {
		for (uartLSR.Get() & (1 << 5)) == 0 {}
		uartDR.Set(uint32('\r'))
	}

	// Also buffer for USB bulk output
	usbBuf[usbBufLen] = c
	usbBufLen++
	if usbBufLen >= 64 || c == '\n' {
		usbFlush()
	}
}

func usbFlush() {
	if usbBufLen == 0 {
		return
	}
	// Check if EP1 IN is active (USBACTEP bit)
	ctl := reg32(dwc2DIEPCTL1).Get()
	if ctl&(1<<15) == 0 {
		usbBufLen = 0 // EP not active, discard
		return
	}
	// Write buffer to EP1 TX FIFO
	n := usbBufLen
	for i := 0; i < n; i += 4 {
		var w uint32
		if i < n {
			w |= uint32(usbBuf[i])
		}
		if i+1 < n {
			w |= uint32(usbBuf[i+1]) << 8
		}
		if i+2 < n {
			w |= uint32(usbBuf[i+2]) << 16
		}
		if i+3 < n {
			w |= uint32(usbBuf[i+3]) << 24
		}
		reg32(dwc2DTXFIFO1).Set(w)
	}
	// Set PKTCNT=1, XFRSIZ=n, enable
	reg32(dwc2DIEPTSIZ1).Set((1 << 19) | uint32(n))
	// EPENA | CNAK (not EPDis = bit30!)
	reg32(dwc2DIEPCTL1).SetBits((1 << 31) | (1 << 28))
	usbBufLen = 0
}

func getchar() byte {
	for (uartLSR.Get() & 1) == 0 {}
	return byte(uartDR.Get() & 0xFF)
}

func machineInit() {
	// Configure GPIO 14/15 as ALT5 (Mini UART)
	sel := reg32(GPFSEL1).Get()
	sel &^= 7 << 12
	sel |= 2 << 12  // ALT5 = 2 for Mini UART TX
	sel &^= 7 << 15
	sel |= 2 << 15  // ALT5 = 2 for Mini UART RX
	reg32(GPFSEL1).Set(sel)

	// Disable pull-ups on GPIO 14/15
	reg32(GPPUD).Set(0)
	for i := 0; i < 150; i++ {}
	reg32(GPPUDCLK0).Set((1 << 14) | (1 << 15))
	for i := 0; i < 150; i++ {}
	reg32(GPPUD).Set(0)
	reg32(GPPUDCLK0).Set(0)

	// Enable Mini UART (AUX peripheral)
	reg32(AUX_ENABLES).Set(1)

	// Disable flow control, set 8-bit mode, set baud 115200
	reg32(AUX_MU_CNTL).Set(0)
	reg32(AUX_MU_LCR).Set(3)
	reg32(AUX_MU_BAUD).Set(271)

	// Enable TX and RX
	reg32(AUX_MU_CNTL).Set(3)

	// Configure Activity LED (GPIO 47) as output
	sel = reg32(GPFSEL1).Get()
	sel &^= 7 << 21
	sel |= 1 << 21
	reg32(GPFSEL1).Set(sel)
}
