import ThermalPrinter from 'react-native-thermal-printer-driver';

// Keep your existing detectPosDevice function, but change the device name matching to "vbprinter"
const printSilently = async (receipt, printer) => {
  try {
    console.log('🖨️ PRINT START → printer:', printer);

    if (!printer) {
      return { success: false, error: 'vbprinter not found. Pair it in Android Bluetooth settings first.' };
    }

    // Build receipt content (using the library's document node API)
    // Note: This library requires a "printer address" (address), which is the Bluetooth MAC address
    const address = printer.address;

    await ThermalPrinter.print(address, [
      // Header
      ThermalPrinter.text('FLASH COURIER', { align: 'center', bold: true, size: 2 }),
      ThermalPrinter.text('Fast • Secure • Reliable', { align: 'center' }),
      ThermalPrinter.text(''),

      // Barcode (top)
      ThermalPrinter.barcode(receipt.barcodeContent, { format: 'CODE128', height: 60, hri: 'below' }),
      ThermalPrinter.text(''),

      // Courier code
      ThermalPrinter.text(`CODE: ${receipt.courierCode}`, { size: 1, bold: true }),
      ThermalPrinter.line(),

      // Body
      ThermalPrinter.text(`Send date: ${receipt.sendDate}`),
      ThermalPrinter.text(`Created: ${receipt.createdAt}`),
      ThermalPrinter.text(`From: ${receipt.fromLocation}`),
      ThermalPrinter.text(`Sender: ${receipt.senderName} (${receipt.senderPhone})`),
      ThermalPrinter.text(`Destination: ${receipt.destination}`),
      ThermalPrinter.text(`Recipient: ${receipt.recipientName} (${receipt.recipientPhone})`),
      ThermalPrinter.text(`Type: ${receipt.typeName}`),
      ThermalPrinter.text(`Price: ${receipt.price} FRW`),
      ThermalPrinter.text(`Qty: ${receipt.quantity}`),
      ThermalPrinter.text(`Time: ${receipt.sentTime}`),
      ThermalPrinter.text(`Note: ${receipt.note}`),
      ThermalPrinter.text(`Served by: ${receipt.fullname}`),

      // Total
      ThermalPrinter.line(),
      ThermalPrinter.text(`TOTAL: ${receipt.amount} FRW`, { size: 1, bold: true }),
      ThermalPrinter.text(''),

      // QR code (footer)
      ThermalPrinter.qr(receipt.qrContent, { size: 6, errorLevel: 'M' }),
      ThermalPrinter.text(''),
      ThermalPrinter.text('Thank you for choosing Flash Courier!', { align: 'center' }),
      ThermalPrinter.text(''),
      ThermalPrinter.text(''),
    ]);

    console.log('🖨️ PRINT DONE');
    return { success: true };
  } catch (e) {
    console.error('🖨️ PRINT FAILED:', e);
    return { success: false, error: e.message || 'Print error' };
  }
};