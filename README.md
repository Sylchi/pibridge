# PiBridge — BLE GPIO Bridge for Raspberry Pi Zero W

> A bare-metal TinyGo firmware that turns a Raspberry Pi Zero W into a
> Bluetooth Low Energy (BLE) peripheral for controlling GPIO, PWM,
> Servo, WS2812 LEDs, and audio.

## Quick Start

### Requirements

- Raspberry Pi Zero W (BCM2835 + BCM43438 WiFi/BT)
- [TinyGo](https://tinygo.org/) (compiled with tinygo-dev or custom LLVM for `armv6k`)
- USB serial cable (optional, for debug output on Mini UART)

### Build

```sh
# Build for Raspberry Pi Zero W (uses project's custom target with hci tags)
tinygo build -target=./targets/pizero.json -o build/kernel-pi.img .

# Alternative: standard TinyGo pizero target with explicit hci tags
tinygo build -target pizero -tags hci,hci_uart -o build/kernel-pi.img .

# Build for QEMU emulation
tinygo build -target=./targets/bcm2835_qemu.json -o build/kernel-qemu.elf .
```

### Flash (Raspberry Pi Zero W)

1. Connect the Pi Zero W in **USB mass storage gadget mode** (rpiboot).
2. Copy `build/kernel-pi.img` to the mounted mass storage device.
3. Reboot — the Pi boots into PiBridge and starts advertising as **"PiBridge"**.

### Run in QEMU

```sh
# Build kernel
tinygo build -target=./targets/bcm2835_qemu.json -o build/kernel-qemu.elf .

# Run in QEMU (raspi0 machine, serial stdio on PL011)
qemu-system-arm -M raspi0 -kernel build/kernel-qemu.elf -serial stdio
```

## Architecture

### Dual-UART Design

The BCM2835 has two UARTs used by PiBridge:

| UART   | Type       | Pins       | Purpose                        |
|--------|------------|------------|---------------------------------|
| UART0  | PL011      | GPIO 32/33 | BCM43438 Bluetooth HCI          |
| UART1  | Mini UART  | GPIO 14/15 | Serial console (debug output)   |

- **`main_pi.go`** configures UART0 for BT firmware loading and HCI transport.
- **`runtime_bcm2835.go`** (real hardware) configures Mini UART for `putchar`/`getchar`.

For QEMU testing, PL011 (UART0) on GPIO 14/15 is used as the serial console,
since QEMU's `raspi0` machine connects PL011 to `-serial stdio`.

### Build Tags

| Tag           | Description                                     |
|---------------|-------------------------------------------------|
| `bcm2835`     | BCM2835 target (set by target JSON)             |
| `hci`         | Enable HCI-based BLE adapter (in `pizero.json`) |
| `hci_uart`    | Enable UART HCI transport (in `pizero.json`)    |
| `!qemu`       | Real hardware                                   |
| `qemu`        | QEMU emulation (no BT, stubs)                   |
| `qemu_test`   | Full QEMU test suite (separate main())          |
| `pizero`      | Pi Zero W (inherits bcm2835)                    |

### Bluetooth Initialization (Pi Zero W)

The BCM43438 Bluetooth chip requires firmware to be loaded via HCI vendor
commands before the standard BLE stack can be started:

1. **`btPowerOn()`** — Drive GPIO 45 high to power the BCM43438, wait 200ms
2. **HCI Reset** — Send standard HCI Reset command (`0x0C03`)
3. **Start Download** — Send vendor command `0xFC2E` to enter firmware download mode
4. **Firmware upload** — Parse and send the 121 HCI commands from `firmware_bcm43438.go`
5. **`adapter.Enable()`** — Standard BLE stack init via the `hciUART` transport

> **⚠️ Known Bug Fixed:** The original raw HCI response parser in
> `btSendRawHCICommand()` read the Command Complete opcode from bytes 3-4 of the
> UART buffer instead of bytes 4-5. The HCI packet type byte (0x04) at index 0
> was not accounted for, causing every opcode comparison to fail. This was fixed
> to read `evtBuf[4:]`.

### Boot Flow

1. **`bcm2835.s`** — ARM vector table + startup (`_start` → clears BSS, copies data → `Reset_Handler`)
2. **`runtime_bcm2835_common.go`** — `main()` → `machineInit()` → `run()` → `exit()`
3. **`machineInit()`** — Configures Mini UART (real HW) or PL011 (QEMU), sets up LED GPIO
4. **`main.go`** — Blinks LED, starts USB polling, calls `runBridge()`
5. **`main_pi.go`** / **`main_qemu.go`** — BT power-on, firmware loading, HCI init, GATT service setup, advertising

## BLE Service

**Service UUID:** `4d697272-6f72-0000-0000-000000000000` ("Mirror")

| Characteristic | UUID (byte 7) | Purpose         |
|----------------|---------------|-----------------|
| DO             | `0x02`        | Digital Out     |
| PW             | `0x04`        | PWM             |
| SV             | `0x05`        | Servo           |
| WF             | `0x07`        | WS2812 LED frame|
| WM             | `0x08`        | WS2812 mode     |
| AU             | `0x09`        | Audio           |

All characteristics use the **Write** permission only (no read/notify).

## USB rpiboot Support

PiBridge responds to `rpiboot` file-server vendor commands over USB,
allowing it to work with the Raspberry Pi's USB mass storage boot mode.
The `USBPoll()` goroutine in `usb_bcm2835.go` handles setup packets and
responds with a "Done" command to satisfy the rpiboot protocol.

## Watchdog

A 30-second watchdog timer (`main.go` `init()`) resets the board after
30 seconds of idle time. This is a safety mechanism for development —
remove or extend for production use.

## Project Structure

```
├── main.go                  # Entry point, LED blink, USB polling, watchdog
├── main_pi.go               # Pi Zero W: BT init, firmware loading, GATT, advertising
├── main_qemu.go             # QEMU stubs (no BT hardware)
├── bcm43438.go              # BCM43438 firmware loader (HCI vendor commands)
├── firmware_bcm43438.go     # Binary firmware blob for BCM43438
├── ws2812_bcm2835.go        # WS2812 LED driver over SPI
├── qemu_test.go             # QEMU BLE-interaction tests
├── qemu_test_main.go        # QEMU comprehensive system tests
├── targets/
│   ├── bcm2835.json         # BCM2835 SoC target definition
│   ├── bcm2835_qemu.json    # QEMU target (inherits bcm2835)
│   ├── pizero.json          # Pi Zero W target (inherits bcm2835)
│   ├── bcm2835.ld           # Linker script (flash at 0x0)
│   ├── bcm2835_qemu.ld     # Linker script for QEMU (flash at 0x10000)
│   └── bcm2835.s            # Startup assembly (vectors, BSS init)
├── src/
│   ├── machine/
│   │   ├── machine_bcm2835.go  # BCM2835 GPIO, UART, SPI, watchdog
│   │   └── usb_bcm2835.go      # DWC2 USB device controller driver
│   └── runtime/
│       ├── runtime_bcm2835.go          # Real hardware runtime (Mini UART)
│       ├── runtime_bcm2835_common.go   # Shared runtime (timer, LED, reset)
│       ├── runtime_bcm2835_qemu.go     # QEMU runtime (PL011 UART)
│       └── interrupt/
│           └── interrupt_bcm2835.go    # Interrupt control
└── mod/
    └── bluetooth/            # Vendored tinygo.org/x/bluetooth v0.15.0
```

## References

- [BCM2835 ARM Peripherals](https://www.raspberrypi.com/documentation/computers/processors.html#bcm2835)
- [BCM43438 datasheet (Cypress CYW43438)](https://www.infineon.com/cms/en/product/wireless-connectivity/airoc-wifi-plus-bluetooth-combos/cyw43438/)
- [TinyGo](https://tinygo.org/)
- [Raspberry Pi Zero W](https://www.raspberrypi.com/products/raspberry-pi-zero-w/)
