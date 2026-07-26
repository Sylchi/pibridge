OUTPUT_ARCH(arm)
ENTRY(_start)

MEMORY {
    FLASH_TEXT (rx) : ORIGIN = 0x00000000, LENGTH = 8M
    RAM (rwx)       : ORIGIN = 0x01000000, LENGTH = 256M
}

_stack_size = 16K;

SECTIONS
{
    .text :
    {
        KEEP (*(.vectors))
        KEEP (*(.init))
        *(.text)
        *(.text.*)
        . = ALIGN(4);
    } >FLASH_TEXT

    .rodata :
    {
        . = ALIGN(4);
        *(.rodata)
        *(.rodata.*)
        . = ALIGN(4);
    } >FLASH_TEXT

    .tinygo_stacksizes :
    {
        *(.tinygo_stacksizes)
    } > FLASH_TEXT

    .stack (NOLOAD) :
    {
        . = ALIGN(4);
        . += _stack_size;
        _stack_top = .;
    } >RAM

    _sidata = LOADADDR(.data);

    .data :
    {
        . = ALIGN(4);
        _sdata = .;
        *(.data)
        *(.data.*)
        . = ALIGN(4);
        _edata = .;
    } >RAM AT>FLASH_TEXT

    .bss :
    {
        . = ALIGN(4);
        _sbss = .;
        *(.bss)
        *(.bss.*)
        *(COMMON)
        . = ALIGN(4);
        _ebss = .;
    } >RAM

    /DISCARD/ :
    {
        *(.ARM.exidx)
        *(.ARM.exidx.*)
    }
}

_heap_start = _ebss;
_heap_end = ORIGIN(RAM) + LENGTH(RAM);
_globals_start = _sdata;
_globals_end = _ebss;
