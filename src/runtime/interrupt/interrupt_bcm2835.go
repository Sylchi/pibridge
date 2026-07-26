//go:build bcm2835

package interrupt

import "device/arm"

// State represents the previous global interrupt state.
type State uint

// Disable disables all interrupts and returns the previous interrupt state.
func Disable() (state State) {
	state = State(arm.AsmFull("mrs {}, cpsr", nil) >> 7 & 1)
	arm.Asm("cpsid i")
	return
}

// Restore restores interrupts to what they were before.
func Restore(state State) {
	if state == 0 {
		arm.Asm("cpsie i")
	}
}

// Enable enables this interrupt (placeholder).
func (irq Interrupt) Enable() {
	// BCM2835 interrupt controller setup would go here.
	// For now, just enable IRQ globally.
	arm.Asm("cpsie i")
}

// In returns whether the system is currently in an interrupt handler.
func In() bool {
	mode := arm.AsmFull("mrs {}, cpsr", nil) & 0x1f
	return mode == 0x12 || mode == 0x11 // IRQ or FIQ mode
}
