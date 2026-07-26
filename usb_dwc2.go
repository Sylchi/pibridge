//go:build !qemu

package main

import (
	"runtime/volatile"
	"time"
	"unsafe"
)

// Direct DWC2 USB OTG register access for the Raspberry Pi Zero W.
// This is needed because TinyGo's src/machine/ override mechanism doesn't
// always pick up project-local files. By keeping the DWC2 driver in the
// main package, we avoid build-system fragility.

const (
	dwc2Base     = 0x20980000
	dwc2GRXSTSP  = dwc2Base + 0x020
	dwc2DIEPCTL0 = dwc2Base + 0x900
	dwc2DIEPTSIZ0 = dwc2Base + 0x910
	dwc2DIEPCTL1 = dwc2Base + 0x920
	dwc2DIEPTSIZ1 = dwc2Base + 0x930
	dwc2DTXFIFO0 = dwc2Base + 0x1000
	dwc2DTXFIFO1 = dwc2Base + 0x1100
	dwc2DOEPCTL0 = dwc2Base + 0xB00
	dwc2DOEPTSIZ0 = dwc2Base + 0xB10
	dwc2DOEP0SETUP0 = dwc2Base + 0xB18
	dwc2DOEP0SETUP1 = dwc2Base + 0xB1C
)

const (
	dwcPktStsSetupRx   = 0x06
	dwcPktStsSetupDone = 0x0C
)

func dwc2Reg(addr uintptr) *volatile.Register32 {
	return (*volatile.Register32)(unsafe.Pointer(addr))
}

// initUSB configures EP1 as a BULK IN endpoint for serial backchannel.
func initUSB() {
	ctl := dwc2Reg(dwc2DIEPCTL1).Get()
	if ctl&(1<<15) != 0 {
		return // Already active
	}

	// MPS=64, EPTYP=Bulk(2), TXFNUM=1, USBACTEP=1, SNAK=1
	val := uint32(0x40)
	val |= (2 << 18)
	val |= (1 << 22)
	val |= (1 << 15)
	val |= (1 << 29)
	dwc2Reg(dwc2DIEPCTL1).Set(val)

	// Enable endpoint
	dwc2Reg(dwc2DIEPCTL1).SetBits(1 << 31)
}

// usbPollLoop checks for pending setup packets and responds to rpiboot.
func usbPollLoop() {
	for {
		grxstsp := dwc2Reg(dwc2GRXSTSP).Get()
		if grxstsp != 0 {
			pktSts := (grxstsp >> 17) & 0x0F
			if pktSts == dwcPktStsSetupRx || pktSts == dwcPktStsSetupDone {
				lo := dwc2Reg(dwc2DOEP0SETUP0).Get()
				hi := dwc2Reg(dwc2DOEP0SETUP1).Get()
				bmRequestType := byte(lo)
				bRequest := byte(lo >> 8)
				wLength := uint16(hi >> 16)

				// rpiboot file server command read
				if bmRequestType == 0xC0 && bRequest == 0 && wLength == 260 {
					var resp [260]byte
					resp[0] = 2 // Done command

					// Write first 64 bytes to EP0 TX FIFO
					n := 64
					for i := 0; i < n; i += 4 {
						var w uint32
						if i < n { w |= uint32(resp[i]) }
						if i+1 < n { w |= uint32(resp[i+1]) << 8 }
						if i+2 < n { w |= uint32(resp[i+2]) << 16 }
						if i+3 < n { w |= uint32(resp[i+3]) << 24 }
						dwc2Reg(dwc2DTXFIFO0).Set(w)
					}
					dwc2Reg(dwc2DIEPTSIZ0).Set((1 << 19) | uint32(n))
					dwc2Reg(dwc2DIEPCTL0).SetBits((1 << 31) | (1 << 28))
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// startUSBPoller launches the USB polling goroutine.
func startUSBPoller() {
	go usbPollLoop()
}
