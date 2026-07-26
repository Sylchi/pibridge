//go:build bcm2835

package runtime

import (
	"device/arm"
	"runtime/volatile"
	"unsafe"
)

const GOARCH = "arm"
const TargetBits = 32
const deferExtraRegs = 0
const callInstSize = 4

const (
	SysTimerFreq = 1000000

	TIMER_BASE = 0x20003000
	TIMER_CLO  = TIMER_BASE + 0x4
	TIMER_CHI  = TIMER_BASE + 0x8

	GPIO_BASE = 0x20200000
	GPFSEL1   = GPIO_BASE + 0x04
	GPPUD     = GPIO_BASE + 0x94
	GPPUDCLK0 = GPIO_BASE + 0x98
	GPPUDCLK1 = GPIO_BASE + 0x9C
	GPSET0    = GPIO_BASE + 0x1C
	GPCLR0    = GPIO_BASE + 0x28
)

var (
	gpset1   = reg32(0x20200020) // GPSET1 for LED (GPIO 47)
	gpclr1   = reg32(0x2020002C) // GPCLR1 for LED (GPIO 47)
	timerClo = reg32(TIMER_CLO)
	timerChi = reg32(TIMER_CHI)
)

func reg32(r uintptr) *volatile.Register32 {
	return (*volatile.Register32)(unsafe.Pointer(r))
}

func ticks() timeUnit {
	lo := timerClo.Get()
	hi := timerChi.Get()
	return timeUnit(hi)<<32 | timeUnit(lo)
}

func ticksToNanoseconds(t timeUnit) int64 {
	return int64(t) * 1000
}

func nanosecondsToTicks(ns int64) timeUnit {
	return timeUnit(ns / 1000)
}

func sleepTicks(d timeUnit) {
	target := ticks() + d
	for ticks() < target {
	}
}

func exit(code int) {
	for i := 0; i < code*3; i++ {
		gpset1.Set(1 << 15)
		sleepTicks(timeUnit(50000))
		gpclr1.Set(1 << 15)
		sleepTicks(timeUnit(50000))
	}
	for {
		arm.Asm("wfi")
	}
}

func abort() {
	for {
		for i := 0; i < 3; i++ {
			gpset1.Set(1 << 15)
			sleepTicks(timeUnit(30000))
			gpclr1.Set(1 << 15)
			sleepTicks(timeUnit(30000))
		}
		sleepTicks(timeUnit(150000))
		for i := 0; i < 3; i++ {
			gpset1.Set(1 << 15)
			sleepTicks(timeUnit(100000))
			gpclr1.Set(1 << 15)
			sleepTicks(timeUnit(100000))
		}
		sleepTicks(timeUnit(150000))
	}
}

func align(ptr uintptr) uintptr {
	return (ptr + 7) &^ 7
}

func getCurrentStackPointer() uintptr {
	return uintptr(stacksave())
}

//export Reset_Handler
func main() {
	machineInit()
	run()
	exit(0)
}

