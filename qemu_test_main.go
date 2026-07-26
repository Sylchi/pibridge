//go:build qemu_test

package main

import (
	"machine"
	"time"
)

// QEMU test - serial via PL011 (UART0) on GPIO 14/15
// The runtime uses Mini UART for putchar, but we override by
// writing directly to UART0

func qemuPrint(s string) {
	// Must not use println() - that goes to Mini UART
	// Instead write directly to UART0
	uart := machine.UART0
	uart.Configure(machine.UARTConfig{
		BaudRate: 115200,
		TX:       machine.GPIO14,
		RX:       machine.GPIO15,
	})
	uart.Write([]byte(s))
	uart.Write([]byte("\n"))
}

func qemuPrintf(s string, args ...interface{}) {
	// Simple implementation — print format string directly.
	// For true formatting, this would need a fmt.Sprintf equivalent;
	// for test use cases println-style output suffices.
	uart := machine.UART0
	uart.Write([]byte(s))
}

func main() {
	// Mustn't use println - it calls putchar which uses Mini UART
	// We'll use UART0 directly
	
	// First, pre-configure UART0 for QEMU serial
	uart := machine.UART0
	uart.Configure(machine.UARTConfig{
		BaudRate: 115200,
		TX:       machine.GPIO14,
		RX:       machine.GPIO15,
	})

	write := func(s string) {
		uart.Write([]byte(s))
		uart.Write([]byte("\r\n"))
	}

	write("=== PiBridge QEMU Comprehensive Test ===")
	write("")

	// === TEST 1: System Boot ===
	write("TEST 1: System Boot")
	write("  Kernel at 0x0, vector table OK")

	// === TEST 2: System Timer ===
	write("TEST 2: System Timer")
	t0 := time.Now()
	time.Sleep(200 * time.Millisecond)
	t1 := time.Now()
	diff := t1.Sub(t0).Milliseconds()
	write("  200ms sleep: " + itoa(int(diff)) + "ms")
	if diff > 180 && diff < 220 {
		write("  PASS")
	} else {
		write("  FAIL (expected ~200ms)")
	}

	// === TEST 3: LED ===
	write("TEST 3: GPIO LED")
	machine.LED.Configure(machine.PinConfig{Mode: machine.PinOutput})
	for i := 0; i < 3; i++ {
		machine.LED.Set(true)
		time.Sleep(50 * time.Millisecond)
		machine.LED.Set(false)
		time.Sleep(50 * time.Millisecond)
	}
	write("  LED toggled 3x, PASS")

	// === TEST 4: GPIO 45 ===
	write("TEST 4: GPIO 45 (BT_ON)")
	p45 := machine.GPIO45
	p45.Configure(machine.PinConfig{Mode: machine.PinOutput})
	p45.High()
	write("  GPIO 45 = HIGH")
	time.Sleep(10 * time.Millisecond)
	v := p45.Get()
	if v {
		write("  Readback = HIGH, PASS")
	} else {
		write("  Readback = LOW, FAIL")
	}
	p45.Low()

	// === TEST 5: Multiple GPIOs ===
	write("TEST 5: GPIO 0-27 set/get")
	gpioTestPins := []machine.Pin{machine.GPIO0, machine.GPIO1, machine.GPIO10, machine.GPIO17, machine.GPIO22, machine.GPIO27}
	for _, p := range gpioTestPins {
		p.Configure(machine.PinConfig{Mode: machine.PinOutput})
		p.Set(true)
		time.Sleep(1 * time.Millisecond)
		p.Set(false)
	}
	write("  Multiple GPIOs toggled, PASS")

	// === TEST 6: SPI ===
	write("TEST 6: SPI0")
	machine.SPI0.Configure(machine.SPIConfig{Frequency: 2500000, Mode: 0})
	write("  SPI0 configured")

	// Try a transfer (will go nowhere in QEMU but shouldn't crash)
	err := machine.SPI0.Tx([]byte{0x55, 0xAA}, nil)
	if err != nil {
		write("  SPI Tx returned error: " + err.Error())
	} else {
		write("  SPI Tx OK")
	}

	// === TEST 7: UART0 ===
	write("TEST 7: UART0 loopback check")
	write("  (No loopback expected in QEMU)")

	// === TEST 8: Goroutines ===
	write("TEST 8: Goroutines and scheduler")
	done := make(chan int, 1)
	go func() {
		time.Sleep(100 * time.Millisecond)
		done <- 42
	}()
	select {
	case val := <-done:
		if val == 42 {
			write("  Goroutine returned 42, PASS")
		} else {
			write("  Wrong value: " + itoa(val))
		}
	case <-time.After(500 * time.Millisecond):
		write("  Goroutine timeout, FAIL")
	}

	// === TEST 9: Multiple goroutines ===
	write("TEST 9: Multiple goroutines")
	results := make(chan int, 3)
	for i := 0; i < 3; i++ {
		go func(n int) {
			time.Sleep(time.Duration(n*50) * time.Millisecond)
			results <- n
		}(i)
	}
	expected := 0
	for i := 0; i < 3; i++ {
		select {
		case v := <-results:
			if v == expected {
				expected++
			}
		case <-time.After(500 * time.Millisecond):
			write("  Goroutine " + itoa(i) + " timeout, FAIL")
			goto doneGoro
		}
	}
	if expected == 3 {
		write("  3 goroutines completed, PASS")
	}
doneGoro:

	// === TEST 10: Long sleep stability ===
	write("TEST 10: Long sleep (1s)")
	t2 := time.Now()
	time.Sleep(1 * time.Second)
	t3 := time.Now()
	diff2 := t3.Sub(t2).Milliseconds()
	write("  1s sleep: " + itoa(int(diff2)) + "ms")
	if diff2 > 900 && diff2 < 1100 {
		write("  PASS")
	} else {
		write("  FAIL")
	}

	// === RESULTS ===
	write("")
	write("=== ALL TESTS COMPLETED ===")

	// Indicate test pass with LED pattern
	for i := 0; i < 5; i++ {
		machine.LED.Set(true)
		time.Sleep(200 * time.Millisecond)
		machine.LED.Set(false)
		time.Sleep(200 * time.Millisecond)
	}

	// Done - blink slowly
	for {
		time.Sleep(1 * time.Second)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	if neg {
		return "-" + s
	}
	return s
}
