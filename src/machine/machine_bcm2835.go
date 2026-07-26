//go:build bcm2835

package machine

import (
	"runtime/interrupt"
	"runtime/volatile"
	"unsafe"
)

const deviceName = "BCM2835"

// DefaultUART is the default UART for machine-level serial access (UART0 / PL011).
// On real Pi hardware, runtime putchar/getchar use Mini UART (UART1) on GPIO 14/15,
// while UART0 on GPIO 32/33 is dedicated to the BCM43438 Bluetooth HCI.
// See runtime_bcm2835.go (Mini UART) vs runtime_bcm2835_qemu.go (PL011).
var DefaultUART = UART0

// BCM2835 MMIO addresses
const (
	PERIPHERAL_BASE = 0x20000000

	TIMER_BASE = PERIPHERAL_BASE + 0x00003000
	TIMER_CLO  = TIMER_BASE + 0x4
	TIMER_CHI  = TIMER_BASE + 0x8

	GPIO_BASE = PERIPHERAL_BASE + 0x00200000
	GPFSEL0   = GPIO_BASE + 0x00
	GPFSEL1   = GPIO_BASE + 0x04
	GPSET0    = GPIO_BASE + 0x1C
	GPSET1    = GPIO_BASE + 0x20
	GPCLR0    = GPIO_BASE + 0x28
	GPCLR1    = GPIO_BASE + 0x2C
	GPLEV0    = GPIO_BASE + 0x34
	GPLEV1    = GPIO_BASE + 0x38
	GPPUD     = GPIO_BASE + 0x94
	GPPUDCLK0 = GPIO_BASE + 0x98
	GPPUDCLK1 = GPIO_BASE + 0x9C

	UART0_BASE = PERIPHERAL_BASE + 0x00201000
	UART0_DR   = UART0_BASE + 0x000
	UART0_FR   = UART0_BASE + 0x018
	UART0_IBRD = UART0_BASE + 0x024
	UART0_FBRD = UART0_BASE + 0x028
	UART0_LCRH = UART0_BASE + 0x02C
	UART0_CR   = UART0_BASE + 0x030
	UART0_IFLS = UART0_BASE + 0x034
	UART0_IMSC = UART0_BASE + 0x038
	UART0_RIS  = UART0_BASE + 0x03C
	UART0_MIS  = UART0_BASE + 0x040
	UART0_ICR  = UART0_BASE + 0x044

	AUX_BASE     = PERIPHERAL_BASE + 0x00215000
	AUX_IRQ      = AUX_BASE + 0x00
	AUX_ENABLES  = AUX_BASE + 0x04
	AUX_MU_IO    = AUX_BASE + 0x40
	AUX_MU_IER   = AUX_BASE + 0x44
	AUX_MU_LCR   = AUX_BASE + 0x4C
	AUX_MU_MCR   = AUX_BASE + 0x50
	AUX_MU_LSR   = AUX_BASE + 0x54
	AUX_MU_CNTL  = AUX_BASE + 0x60
	AUX_MU_BAUD  = AUX_BASE + 0x68

	IRQ_BASE          = PERIPHERAL_BASE + 0x0000B200
	IRQ_BASIC_PENDING = IRQ_BASE + 0x00
	IRQ_PENDING1      = IRQ_BASE + 0x04
	IRQ_PENDING2      = IRQ_BASE + 0x08
	IRQ_ENABLE1       = IRQ_BASE + 0x10
	IRQ_ENABLE2       = IRQ_BASE + 0x14
	IRQ_ENABLE_BASIC  = IRQ_BASE + 0x18
)

const (
	IRQ_UART0 = 57
	IRQ_AUX   = 29
)

// Pin constants
const (
	GPIO0  Pin = 0
	GPIO1  Pin = 1
	GPIO2  Pin = 2
	GPIO3  Pin = 3
	GPIO4  Pin = 4
	GPIO5  Pin = 5
	GPIO6  Pin = 6
	GPIO7  Pin = 7
	GPIO8  Pin = 8
	GPIO9  Pin = 9
	GPIO10 Pin = 10
	GPIO11 Pin = 11
	GPIO12 Pin = 12
	GPIO13 Pin = 13
	GPIO14 Pin = 14
	GPIO15 Pin = 15
	GPIO16 Pin = 16
	GPIO17 Pin = 17
	GPIO18 Pin = 18
	GPIO19 Pin = 19
	GPIO20 Pin = 20
	GPIO21 Pin = 21
	GPIO22 Pin = 22
	GPIO23 Pin = 23
	GPIO24 Pin = 24
	GPIO25 Pin = 25
	GPIO26 Pin = 26
	GPIO27 Pin = 27
	GPIO28 Pin = 28
	GPIO29 Pin = 29
	GPIO30 Pin = 30
	GPIO31 Pin = 31
	GPIO32 Pin = 32
	GPIO33 Pin = 33
	GPIO34 Pin = 34
	GPIO35 Pin = 35
	GPIO36 Pin = 36
	GPIO37 Pin = 37
	GPIO38 Pin = 38
	GPIO39 Pin = 39
	GPIO40 Pin = 40
	GPIO41 Pin = 41
	GPIO42 Pin = 42
	GPIO43 Pin = 43
	GPIO44 Pin = 44
	GPIO45 Pin = 45
	GPIO46 Pin = 46
	GPIO47 Pin = 47
	GPIO48 Pin = 48
	GPIO49 Pin = 49
	GPIO50 Pin = 50
	GPIO51 Pin = 51
	GPIO52 Pin = 52
	GPIO53 Pin = 53
)

const LED Pin = 47

// PinMode constants for BCM2835
const (
	PinInput  PinMode = 0
	PinOutput PinMode = 1
	PinInputPullup   PinMode = 2
	PinInputPulldown PinMode = 3
	PinAlt0 PinMode = 4
	PinAlt1 PinMode = 5
	PinAlt2 PinMode = 6
	PinAlt3 PinMode = 7
	PinAlt4 PinMode = 8
	PinAlt5 PinMode = 9
)

func mmio(addr uintptr) *volatile.Register32 {
	return (*volatile.Register32)(unsafe.Pointer(addr))
}

func (p Pin) Configure(config PinConfig) {
	if p > 53 {
		return
	}
	selReg := GPFSEL0 + uintptr(p/10)*4
	shift := uint(p%10) * 3
	reg := mmio(selReg)
	val := reg.Get()
	val &^= 7 << shift

	switch config.Mode {
	case PinOutput:
		val |= 1 << shift
	case PinAlt0:
		val |= 4 << shift
	case PinAlt1:
		val |= 5 << shift
	case PinAlt2:
		val |= 6 << shift
	case PinAlt3:
		val |= 7 << shift
	case PinAlt4:
		val |= 3 << shift
	case PinAlt5:
		val |= 2 << shift
	case PinInputPullup:
		val |= 0 << shift
		if p < 32 {
			mmio(GPPUD).Set(2)
			for i := 0; i < 150; i++ {}
			mmio(GPPUDCLK0).Set(1 << uint(p))
			for i := 0; i < 150; i++ {}
			mmio(GPPUD).Set(0)
			mmio(GPPUDCLK0).Set(0)
		} else {
			mmio(GPPUD).Set(2)
			for i := 0; i < 150; i++ {}
			mmio(GPPUDCLK1).Set(1 << uint(p-32))
			for i := 0; i < 150; i++ {}
			mmio(GPPUD).Set(0)
			mmio(GPPUDCLK1).Set(0)
		}
		return
	case PinInputPulldown:
		val |= 0 << shift
		if p < 32 {
			mmio(GPPUD).Set(1)
			for i := 0; i < 150; i++ {}
			mmio(GPPUDCLK0).Set(1 << uint(p))
			for i := 0; i < 150; i++ {}
			mmio(GPPUD).Set(0)
			mmio(GPPUDCLK0).Set(0)
		} else {
			mmio(GPPUD).Set(1)
			for i := 0; i < 150; i++ {}
			mmio(GPPUDCLK1).Set(1 << uint(p-32))
			for i := 0; i < 150; i++ {}
			mmio(GPPUD).Set(0)
			mmio(GPPUDCLK1).Set(0)
		}
		return
	default:
		val |= 0 << shift
	}
	reg.Set(val)
}

func (p Pin) Set(value bool) {
	if value {
		if p < 32 {
			mmio(GPSET0).Set(1 << uint(p))
		} else {
			mmio(GPSET1).Set(1 << uint(p-32))
		}
	} else {
		if p < 32 {
			mmio(GPCLR0).Set(1 << uint(p))
		} else {
			mmio(GPCLR1).Set(1 << uint(p-32))
		}
	}
}

func (p Pin) Get() bool {
	var reg uintptr
	var bit uint
	if p < 32 {
		reg = GPLEV0
		bit = uint(p)
	} else {
		reg = GPLEV1
		bit = uint(p - 32)
	}
	return (mmio(reg).Get()>>bit)&1 != 0
}

// UART
type UART struct {
	Buffer *RingBuffer
}

var (
	UART0  = &_UART0
	_UART0 = UART{Buffer: NewRingBuffer()}
	UART1  = &_UART1
	_UART1 = UART{Buffer: NewRingBuffer()}
)

func (uart *UART) Configure(config UARTConfig) {
	if config.BaudRate == 0 {
		config.BaudRate = 115200
	}

	if uart == UART0 {
		if config.TX == 0 {
			config.TX = GPIO14
			config.RX = GPIO15
		}
		// Use correct alt function based on pin number
		// GPIO 14/15: ALT0, GPIO 32/33: ALT3, GPIO 36/37: ALT2
		txAlt := PinAlt0
		rxAlt := PinAlt0
		if config.TX == GPIO32 || config.TX == GPIO33 {
			txAlt = PinAlt3
			rxAlt = PinAlt3
		} else if config.TX == GPIO36 || config.TX == GPIO37 {
			txAlt = PinAlt2
			rxAlt = PinAlt2
		}
		config.TX.Configure(PinConfig{Mode: txAlt})
		config.RX.Configure(PinConfig{Mode: rxAlt})

		// Disable pull-ups on UART pins
		// GPIO 0-31 use GPPUDCLK0, GPIO 32-53 use GPPUDCLK1
		mmio(GPPUD).Set(0)
		for i := 0; i < 150; i++ {}
		clkMask0 := uint32(0)
		clkMask1 := uint32(0)
		if config.TX == GPIO14 || config.RX == GPIO15 {
			clkMask0 |= (1 << 14) | (1 << 15)
		}
		if config.TX >= 32 {
			clkMask1 |= 1 << uint(config.TX-32)
		}
		if config.RX >= 32 {
			clkMask1 |= 1 << uint(config.RX-32)
		}
		if clkMask0 != 0 {
			mmio(GPPUDCLK0).Set(clkMask0)
		}
		if clkMask1 != 0 {
			mmio(GPPUDCLK1).Set(clkMask1)
		}
		for i := 0; i < 150; i++ {}
		mmio(GPPUD).Set(0)
		mmio(GPPUDCLK0).Set(0)
		mmio(GPPUDCLK1).Set(0)
		for i := 0; i < 150; i++ {}
		mmio(GPPUD).Set(0)
		mmio(GPPUDCLK0).Set(0)
		mmio(GPPUDCLK1).Set(0)

		mmio(UART0_CR).Set(0)
		mmio(UART0_ICR).Set(0x7FF)

		ibrd := uint32(48000000 / (16 * config.BaudRate))
		fbrd := uint32(((48000000 * 64) / (16 * config.BaudRate)) - (ibrd * 64) + 1)
		mmio(UART0_IBRD).Set(ibrd)
		mmio(UART0_FBRD).Set(fbrd)

		mmio(UART0_LCRH).Set((3 << 5) | (1 << 4))
		mmio(UART0_IMSC).Set(1 << 4)
		mmio(UART0_CR).Set((1 << 0) | (1 << 8) | (1 << 9))

		intr := interrupt.New(IRQ_UART0, _UART0.handleInterrupt)
		intr.Enable()

	} else if uart == UART1 {
		if config.TX == 0 {
			config.TX = GPIO14
			config.RX = GPIO15
		}
		config.TX.Configure(PinConfig{Mode: PinAlt5})
		config.RX.Configure(PinConfig{Mode: PinAlt5})

		mmio(AUX_ENABLES).Set(1)
		mmio(AUX_MU_CNTL).Set(0)
		mmio(AUX_MU_IER).Set(1)
		mmio(AUX_MU_LCR).Set(3)
		mmio(AUX_MU_MCR).Set(0)

		baud := uint32(250000000/(8*config.BaudRate) - 1)
		mmio(AUX_MU_BAUD).Set(baud)
		mmio(AUX_MU_CNTL).Set(3)

		intr := interrupt.New(IRQ_AUX, _UART1.handleInterrupt)
		intr.Enable()
	}
}

func (uart *UART) handleInterrupt(intr interrupt.Interrupt) {
	if uart == UART0 {
		if mmio(UART0_MIS).Get()&(1<<4) != 0 {
			data := mmio(UART0_DR).Get()
			uart.Receive(byte(data & 0xFF))
			mmio(UART0_ICR).Set(1 << 4)
		}
	} else if uart == UART1 {
		if mmio(AUX_MU_LSR).Get()&1 != 0 {
			data := mmio(AUX_MU_IO).Get()
			uart.Receive(byte(data & 0xFF))
		}
	}
}

func (uart *UART) writeByte(c byte) error {
	if uart == UART0 {
		for mmio(UART0_FR).Get()&(1<<5) != 0 {}
		mmio(UART0_DR).Set(uint32(c))
	} else if uart == UART1 {
		for mmio(AUX_MU_LSR).Get()&(1<<5) == 0 {}
		mmio(AUX_MU_IO).Set(uint32(c))
	}
	return nil
}

func (uart *UART) flush() {
	if uart == UART0 {
		for mmio(UART0_FR).Get()&((1<<3)|(1<<5)) != 0 {}
	} else if uart == UART1 {
		for mmio(AUX_MU_LSR).Get()&(1<<5) == 0 {}
	}
}

// SPI0 registers (BCM2835)
const (
	SPI0_BASE = PERIPHERAL_BASE + 0x00204000
	SPI0_CS   = SPI0_BASE + 0x00
	SPI0_FIFO = SPI0_BASE + 0x04
	SPI0_CLK  = SPI0_BASE + 0x08
	SPI0_DLEN = SPI0_BASE + 0x0C
	SPI0_DC   = SPI0_BASE + 0x14

	SPI_CS_CPHA     = 1 << 1
	SPI_CS_CPOL     = 1 << 2
	SPI_CS_CLEAR_RX = 1 << 4
	SPI_CS_CLEAR_TX = 1 << 5
	SPI_CS_TA       = 1 << 7
	SPI_CS_DONE     = 1 << 16
	SPI_CS_RXD      = 1 << 17
	SPI_CS_TXD      = 1 << 18
	SPI_CS_RXR      = 1 << 19
	SPI_CS_TE       = 1 << 21
)

// SPI
type SPI struct {
	Bus uint8
}

type SPIConfig struct {
	Frequency uint32
	SCK       Pin
	SDO       Pin
	SDI       Pin
	LSBFirst  bool
	Mode      uint8
}

const (
	SPI0_SCK_PIN = GPIO11
	SPI0_SDO_PIN = GPIO10
	SPI0_SDI_PIN = GPIO9
	SPI0_CS_PIN  = GPIO8
	SPI1_SCK_PIN = GPIO19
	SPI1_SDO_PIN = GPIO20
	SPI1_SDI_PIN = GPIO21
)

var (
	SPI0 = &_SPI0
	_SPI0 = SPI{Bus: 0}
)

func (spi *SPI) Configure(config SPIConfig) error {
	if config.Frequency == 0 {
		config.Frequency = 2500000
	}
	if spi.Bus == 0 {
		if config.SCK == 0 {
			config.SCK = SPI0_SCK_PIN
		}
		if config.SDO == 0 {
			config.SDO = SPI0_SDO_PIN
		}
		if config.SDI == 0 {
			config.SDI = SPI0_SDI_PIN
		}
		config.SCK.Configure(PinConfig{Mode: PinAlt0})
		config.SDO.Configure(PinConfig{Mode: PinAlt0})
		config.SDI.Configure(PinConfig{Mode: PinAlt0})
		clk := CPUFrequencyValue / config.Frequency
		mmio(SPI0_CLK).Set(clk)
		cs := uint32(0)
		if config.Mode&0x02 != 0 {
			cs |= SPI_CS_CPHA
		}
		if config.Mode&0x04 != 0 {
			cs |= SPI_CS_CPOL
		}
		mmio(SPI0_CS).Set(cs)
	}
	return nil
}

func (spi *SPI) Tx(w, r []byte) error {
	if spi.Bus == 0 {
		regCS := mmio(SPI0_CS)
		regFIFO := mmio(SPI0_FIFO)
		var sent, recv int
		wlen := len(w)
		rlen := len(r)
		maxLen := wlen
		if rlen > maxLen {
			maxLen = rlen
		}
		regCS.Set(regCS.Get() | SPI_CS_TA | SPI_CS_CLEAR_RX | SPI_CS_CLEAR_TX)
		for sent < maxLen || recv < maxLen {
			if sent < wlen && (regCS.Get()&SPI_CS_TXD) != 0 {
				regFIFO.Set(uint32(w[sent]))
				sent++
			}
			if sent < maxLen && sent >= wlen && (regCS.Get()&SPI_CS_TXD) != 0 {
				regFIFO.Set(0)
				sent++
			}
			if recv < rlen && (regCS.Get()&SPI_CS_RXD) != 0 {
				r[recv] = byte(regFIFO.Get() & 0xFF)
				recv++
			}
			if recv < maxLen && recv >= rlen && (regCS.Get()&SPI_CS_RXD) != 0 {
				regFIFO.Get()
				recv++
			}
		}
		for (regCS.Get() & SPI_CS_DONE) == 0 {
		}
		regCS.Set(regCS.Get() &^ SPI_CS_TA)
	}
	return nil
}

func (spi *SPI) Transfer(w byte) (byte, error) {
	var r [1]byte
	err := spi.Tx([]byte{w}, r[:])
	return r[0], err
}

const CPUFrequencyValue = 250000000

func CPUFrequency() uint32 {
	return CPUFrequencyValue
}

// WatchdogReset triggers a full system reset using the BCM2835 watchdog timer.
// delayUs is the delay before reset in microseconds (~100000 = 100ms minimum).
// Uses Linux bcm2835_wdt.c sequence: read-modify-write PM_RSTC.
func WatchdogReset(delayUs uint32) {
	const (
		PM_RSTC               = 0x2010001c
		PM_RSTS               = 0x20100020
		PM_WDOG               = 0x20100024
		MAGIC                 = 0x5a000000
		PM_WDOG_TIME_SET      = 0x000fffff
		PM_RSTC_WRCFG_CLR     = 0xffffffcf
		PM_RSTC_WRCFG_FULL_RESET = 0x00000020
	)
	// Convert delay to watchdog ticks (1 tick = 1/65536 sec on BCM2835)
	// ticks = delayUs * 65536 / 1000000
	ticks := (delayUs * 65536 + 999999) / 1000000
	if ticks > PM_WDOG_TIME_SET {
		ticks = PM_WDOG_TIME_SET
	}
	// Set watchdog timeout (must be set before PM_RSTC)
	mmio(PM_WDOG).Set(MAGIC | uint32(ticks&PM_WDOG_TIME_SET))

	// Read PM_RSTC, clear config bits, set full reset (read-modify-write)
	cur := mmio(PM_RSTC).Get()
	cur = (cur & PM_RSTC_WRCFG_CLR) | MAGIC | PM_RSTC_WRCFG_FULL_RESET
	mmio(PM_RSTC).Set(cur)

	// If reset doesn't happen, halt
	for {}
}
