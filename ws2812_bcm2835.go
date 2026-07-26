//go:build bcm2835 && !qemu

package main

import (
	"machine"
	"unsafe"
)

// WS2812 SPI encoder.
// Each WS2812 bit is encoded as 3 SPI bits at ~2.5 MHz (400ns per SPI bit):
//   0 → 0b100 (400ns high, 800ns low)
//   1 → 0b110 (800ns high, 400ns low)
//
// This gives:
//   T0H ≈ 400ns  (spec: 350ns ±150ns) ✅
//   T0L ≈ 800ns  (spec: 900ns ±150ns) ✅ within tolerance
//   T1H ≈ 800ns  (spec: 900ns ±150ns) ✅ within tolerance
//   T1L ≈ 400ns  (spec: 350ns ±150ns) ✅
//
// Each WS2812 byte (8 bits) → 3 SPI bytes
// Each WS2812 pixel (3 bytes RGB/GRB) → 9 SPI bytes

// Precomputed lookup table: ws2812Byte[i] = 3 SPI bytes for WS2812 byte value i
// Bit encoding: bit 7..0 of WS2812 byte → bits [23:0] of SPI data
//   WS2812 bit = 0 → SPI bits = 100
//   WS2812 bit = 1 → SPI bits = 110
//   (MSB first for both)
var ws2812Lookup [256][3]byte

func init() {
	// Build lookup table
	for i := 0; i < 256; i++ {
		val := uint32(0)
		for b := 7; b >= 0; b-- {
			val <<= 3
			if (i>>b)&1 != 0 {
				val |= 0b110 // 1 bit: 800ns high, 400ns low
			} else {
				val |= 0b100 // 0 bit: 400ns high, 800ns low
			}
		}
		ws2812Lookup[i][0] = byte(val >> 16)
		ws2812Lookup[i][1] = byte(val >> 8)
		ws2812Lookup[i][2] = byte(val)
	}
}

// ws2812SPI sends RGB data to a WS2812 strip via SPI.
// data is raw RGB bytes (each pixel: R, G, B). The lookup table
// encodes each byte as 3 SPI bits-per-bit, but does NOT reorder
// to GRB — the caller must use ws2812GRBtoRGB() if GRB is needed.
// The pin is ignored - we use SPI0 MOSI (GPIO10).
func ws2812SPI(data []byte) {
	// Each WS2812 byte → 3 SPI bytes
	bufLen := len(data) * 3
	// Allocate buffer on stack for small transfers, heap for large
	var buf []byte
	if bufLen <= 512 {
		var stackBuf [512]byte
		buf = stackBuf[:bufLen]
	} else {
		buf = make([]byte, bufLen)
	}

	// Encode using lookup table.
	// Each WS2812 byte is expanded to 3 SPI bytes via the lookup table.
	// The data is sent byte-by-byte as-is (RGB order). If the target
	// strip expects GRB order, call ws2812GRBtoRGB() first.
	for i := 0; i < len(data); i++ {
		idx := i * 3
		entry := &ws2812Lookup[data[i]]
		buf[idx+0] = entry[0]
		buf[idx+1] = entry[1]
		buf[idx+2] = entry[2]
	}

	// Send via SPI
	machine.SPI0.Tx(buf, nil)

	// Reset pulse: ~50µs low (send 0s)
	// At 2.5 MHz, 125 bits = 50µs. Send 16 zero bytes = 128 bits.
	var reset [16]byte
	machine.SPI0.Tx(reset[:], nil)
}

// ws2812GRBtoRGB converts RGB bytes to GRB order (what most WS2812
// strips expect). Returns a new slice with reordered bytes.
// Call this on incoming RGB data before passing to ws2812SPI().
func ws2812GRBtoRGB(rgb []byte) []byte {
	n := len(rgb)
	// Round down to multiple of 3
	n = n - (n % 3)
	grb := make([]byte, n)
	for i := 0; i < n; i += 3 {
		grb[i+0] = rgb[i+1] // G
		grb[i+1] = rgb[i+0] // R
		grb[i+2] = rgb[i+2] // B
	}
	return grb
}

// Helper to convert uintptr to *volatile.Register32 for GPIO
type wsReg32 *uint32

func wsSetGPIO(pin uint, val bool) {
	if pin < 32 {
		if val {
			*(*uint32)(unsafe.Pointer(uintptr(0x20200000 + 0x1C))) = 1 << pin
		} else {
			*(*uint32)(unsafe.Pointer(uintptr(0x20200000 + 0x28))) = 1 << pin
		}
	} else {
		if val {
			*(*uint32)(unsafe.Pointer(uintptr(0x20200000 + 0x20))) = 1 << (pin - 32)
		} else {
			*(*uint32)(unsafe.Pointer(uintptr(0x20200000 + 0x2C))) = 1 << (pin - 32)
		}
	}
}
