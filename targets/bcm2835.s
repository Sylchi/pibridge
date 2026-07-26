// ARM exception vector table - must be at address 0x0
// QEMU raspi0 quirk: `ldr pc, [pc, #offset]` at address 0 doesn't work for
// reset (cache coherency). Using branch instructions instead.
.section .vectors,"ax"
.global _vectors
_vectors:
    b       _start
    b       hang
    b       hang
    b       hang
    b       hang
    b       hang
    ldr     pc, irq_redirect
    ldr     pc, fiq_redirect

irq_redirect:
    b       irq_handler
fiq_redirect:
    b       hang

.section .init,"ax"
.global     _start
.type       _start, %function
.align
.arm

_start:
    // Set stack pointer
    ldr     sp, =_stack_top

    // Clear BSS
    ldr     r0, =_sbss
    ldr     r1, =_ebss
    mov     r2, #0
bss_loop:
    cmp     r0, r1
    bge     bss_done
    str     r2, [r0], #4
    b       bss_loop
bss_done:

    // Copy .data from flash to RAM
    ldr     r0, =_sdata
    ldr     r1, =_edata
    ldr     r2, =_sidata
data_loop:
    cmp     r0, r1
    bge     data_done
    ldr     r3, [r2], #4
    str     r3, [r0], #4
    b       data_loop
data_done:

    // Jump to Reset_Handler (TinyGo runtime entry)
    ldr     r3, =Reset_Handler
    bx      r3

hang:
    b       hang

// Simple IRQ handler - acknowledges UART0 and returns
irq_handler:
    sub     lr, lr, #4
    push    {r0-r3, r12, lr}
    
    // Clear UART0 interrupt
    ldr     r0, =0x20201044   // UART0_ICR
    ldr     r1, =0x7FF
    str     r1, [r0]
    
    // Return from exception
    ldm     sp!, {r0-r3, r12, pc}^
