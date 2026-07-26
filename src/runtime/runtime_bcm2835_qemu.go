//go:build bcm2835 && qemu

package runtime

// QEMU-specific serial: PL011 (UART0) on GPIO 14/15
// QEMU connects PL011 to -serial stdio.

const (
	UART0_BASE = 0x20201000
	UART0_DR   = UART0_BASE + 0x000
	UART0_FR   = UART0_BASE + 0x018
	UART0_IBRD = UART0_BASE + 0x024
	UART0_FBRD = UART0_BASE + 0x028
	UART0_LCRH = UART0_BASE + 0x02C
	UART0_CR   = UART0_BASE + 0x030
	UART0_ICR  = UART0_BASE + 0x044

	PL011_FR_TXFF = 1 << 5
	PL011_FR_RXFE = 1 << 4
)

var (
	uartPL011DR = reg32(UART0_DR)
	uartPL011FR = reg32(UART0_FR)
)

func putchar(c byte) {
	for (uartPL011FR.Get() & PL011_FR_TXFF) != 0 {}
	uartPL011DR.Set(uint32(c))
	if c == '\n' {
		for (uartPL011FR.Get() & PL011_FR_TXFF) != 0 {}
		uartPL011DR.Set(uint32('\r'))
	}
}

func getchar() byte {
	for (uartPL011FR.Get() & PL011_FR_RXFE) != 0 {}
	return byte(uartPL011DR.Get() & 0xFF)
}

func machineInit() {
	// Configure GPIO 14/15 as ALT0 (PL011 UART0)
	sel := reg32(GPFSEL1).Get()
	sel &^= 7 << 12
	sel |= 4 << 12  // ALT0 = 4 for PL011 TX
	sel &^= 7 << 15
	sel |= 4 << 15  // ALT0 = 4 for PL011 RX
	reg32(GPFSEL1).Set(sel)

	// Disable pull-ups on GPIO 14/15
	reg32(GPPUD).Set(0)
	for i := 0; i < 150; i++ {}
	reg32(GPPUDCLK0).Set((1 << 14) | (1 << 15))
	for i := 0; i < 150; i++ {}
	reg32(GPPUD).Set(0)
	reg32(GPPUDCLK0).Set(0)

	// Init PL011 at 115200
	// IBRD = 250000000/(16*115200) = 135.5 → 135
	// FBRD = ((250000000*64)/(16*115200)) - 135*64 = 32
	reg32(UART0_CR).Set(0)
	reg32(UART0_ICR).Set(0x7FF)
	reg32(UART0_IBRD).Set(135)
	reg32(UART0_FBRD).Set(32)
	reg32(UART0_LCRH).Set((3 << 5) | (1 << 4)) // 8-bit, FIFO enable
	reg32(UART0_CR).Set((1 << 0) | (1 << 8) | (1 << 9)) // UARTEN | TXE | RXE

	// Configure Activity LED (GPIO 47) as output
	sel = reg32(GPFSEL1).Get()
	sel &^= 7 << 21
	sel |= 1 << 21
	reg32(GPFSEL1).Set(sel)
}
