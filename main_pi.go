//go:build !qemu

package main

import (
	"machine"
	"time"
	"tinygo.org/x/bluetooth"
)

func runBridge() error {
	// Configure UART0 (PL011) for BCM43438 Bluetooth HCI on GPIO 32/33.
	// Note: The serial console (putchar/getchar) uses Mini UART (UART1) on
	// GPIO 14/15, configured in runtime_bcm2835.go. This split leaves UART0
	// exclusively for the BT modem.
	machine.UART0.Configure(machine.UARTConfig{
		BaudRate: 115200,
		TX:       machine.GPIO32,
		RX:       machine.GPIO33,
	})

	// Set UART for the bluetooth adapter
	adapter.SetUART(machine.UART0)

	println("BT power on...")
	btPowerOn()
	time.Sleep(100 * time.Millisecond)

	println("Loading BT firmware...")
	if err := btLoadFirmware(machine.UART0); err != nil {
		return err
	}
	time.Sleep(200 * time.Millisecond)

	println("BLE init...")
	if err := adapter.Enable(); err != nil {
		return err
	}
	println("BLE enabled")

	println("GATT setup...")
	svc := &bluetooth.Service{
		UUID: svcUUID(),
		Characteristics: []bluetooth.CharacteristicConfig{
			{Handle: &chDo, UUID: charUUID(0x02), Flags: bluetooth.CharacteristicWritePermission, WriteEvent: doCB},
			{Handle: &chPw, UUID: charUUID(0x04), Flags: bluetooth.CharacteristicWritePermission, WriteEvent: pwCB},
			{Handle: &chSv, UUID: charUUID(0x05), Flags: bluetooth.CharacteristicWritePermission, WriteEvent: svCB},
			{Handle: &chWf, UUID: charUUID(0x07), Flags: bluetooth.CharacteristicWritePermission, WriteEvent: wfCB},
			{Handle: &chWm, UUID: charUUID(0x08), Flags: bluetooth.CharacteristicWritePermission, WriteEvent: wmCB},
			{Handle: &chAu, UUID: charUUID(0x09), Flags: bluetooth.CharacteristicWritePermission, WriteEvent: auCB},
		},
	}
	if err := adapter.AddService(svc); err != nil {
		return err
	}
	println("GATT OK")

	println("Advertising...")
	adv := adapter.DefaultAdvertisement()
	if err := adv.Configure(bluetooth.AdvertisementOptions{
		LocalName: "PiBridge",
	}); err != nil {
		return err
	}
	if err := adv.Start(); err != nil {
		return err
	}

	return nil
}
