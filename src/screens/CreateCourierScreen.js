import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, Alert, Platform, NativeModules, PermissionsAndroid,
} from 'react-native';
import RNBluetoothClassic from 'react-native-bluetooth-classic';
import ThermalPrinter, { text, barcode, qr, line } from 'react-native-thermal-printer-driver';
import { authFetch } from '../services/api';

// ============================================================
// POS DETECTION + DYNAMIC PRINTER DISCOVERY
// Finds the built-in "vbprinter" via paired Bluetooth devices,
// so it works on every Q2i device regardless of its MAC address.
// ============================================================
let _posCache = null;

const detectPosDevice = async () => {
  if (_posCache !== null) return _posCache;

  if (Platform.OS !== 'android') {
    _posCache = { isPos: false, printer: null };
    return _posCache;
  }

  const model = NativeModules.PlatformConstants?.Model || '';
  const modelLooksLikePos = /Q2i|GOOJPRT|POS|Sunmi|PAX|iMin/i.test(model);

  let printer = null;
  try {
    const enabled = await RNBluetoothClassic.isBluetoothEnabled();
    if (enabled) {
      const paired = await RNBluetoothClassic.getBondedDevices();
      const vb = paired.find((d) =>
        (d.name || '').toLowerCase().includes('vbprinter')
      );
      if (vb) {
        printer = { name: vb.name, address: vb.address };
      }
    }
  } catch (e) {
    console.warn('Bluetooth discovery failed:', e);
  }

  const isPos = !!printer || modelLooksLikePos;
  _posCache = { isPos, printer, model };
  console.log('🔎 POS DETECTION →', { isPos, printer, model });
  return _posCache;
};

// ============================================================
// SILENT ESC/POS PRINT (58mm thermal)
// ============================================================
const printSilently = async (receipt, printer) => {
  try {
    console.log('🖨️ PRINT START → printer:', printer);

    if (!printer || !printer.address) {
      return {
        success: false,
        error:
          'vbprinter not found. Pair it once in Android Settings → Bluetooth, then retry.',
      };
    }

    const address = `bt:${printer.address}`;
    console.log('🖨️ Connecting to:', address);

    // Optional connection test
    try {
      const test = await ThermalPrinter.testConnection(address);
      console.log('🖨️ Connection test:', test);
      if (test && test.success === false) {
        return {
          success: false,
          error: `Cannot connect: ${test.deviceName || test.error || 'unknown'}`,
        };
      }
    } catch (connErr) {
      console.error('🖨️ Connection test failed:', connErr?.code, connErr?.message);
      return { success: false, error: connErr?.message || 'Connection failed' };
    }

    const result = await ThermalPrinter.print(
      address,
      [
        // Header
        text('FLASH COURIER', { align: 'center', bold: true, size: 2 }),
        text('Fast • Secure • Reliable', { align: 'center' }),
        text(''),

        // Barcode (top)
        barcode(receipt.barcodeContent, {
          format: 'CODE128',
          height: 60,
          hri: 'below',
        }),
        text(''),

        // Courier code
        text(`CODE: ${receipt.courierCode}`, { size: 1, bold: true }),
        line(),

        // Body
        text(`Send date: ${receipt.sendDate}`),
        text(`Created: ${receipt.createdAt}`),
        text(`From: ${receipt.fromLocation}`),
        text(`Sender: ${receipt.senderName} (${receipt.senderPhone})`),
        text(`Destination: ${receipt.destination}`),
        text(`Recipient: ${receipt.recipientName} (${receipt.recipientPhone})`),
        text(`Type: ${receipt.typeName}`),
        text(`Price: ${receipt.price} FRW`),
        text(`Qty: ${receipt.quantity}`),
        text(`Time: ${receipt.sentTime}`),
        text(`Note: ${receipt.note}`),
        text(`Served by: ${receipt.fullname}`),

        // Total
        line(),
        text(`TOTAL: ${receipt.amount} FRW`, { size: 1, bold: true }),
        text(''),

        // QR code (footer)
        qr(receipt.qrContent, { size: 6, errorLevel: 'M' }),
        text(''),
        text('Thank you for choosing Flash Courier!', { align: 'center' }),
        text(''),
        text(''),
      ],
      {
        paperWidthMm: 58,
        timeout: 15000,
        keepAlive: false,
      }
    );

    console.log('🖨️ PRINT RESULT:', result);
    return {
      success: !!result?.success,
      error: result?.success ? null : result?.error || 'Print failed',
    };
  } catch (e) {
    console.error('🖨️ PRINT FAILED:', e?.code, e?.message);
    return { success: false, error: e?.message || 'Print error' };
  }
};

// ============================================================
// RESPONSE NORMALIZER
// Handles { success, courier } and { ok, data } shapes
// ============================================================
const normalizeCourierResponse = async (res) => {
  let body = res;
  if (
    body &&
    typeof body.json === 'function' &&
    typeof body.status === 'number'
  ) {
    body = await body.json();
  }
  if (!body || typeof body !== 'object') {
    throw new Error('Empty server response');
  }

  const candidates = [
    body.courier,
    body.data && body.data.courier,
    body.data,
    body.result,
    body,
  ];

  let courier = null;
  for (const c of candidates) {
    if (
      c &&
      typeof c === 'object' &&
      (c.courier_id || c.id || c.tracking)
    ) {
      courier = c;
      break;
    }
  }

  if (body.ok === false || body.success === false || (body.error && !courier)) {
    throw new Error(body.error || body.message || 'Server rejected');
  }
  if (!courier) {
    throw new Error(
      `No courier in response: ${JSON.stringify(body).slice(0, 300)}`
    );
  }
  if (!courier.id) {
    courier.id = courier.courier_id || courier.tracking;
  }

  const sms =
    (body.sms && (body.sms.status || body.sms)) ||
    (courier.sms && (courier.sms.status || courier.sms)) ||
    null;

  return { courier, sms };
};

// ============================================================
// SCREEN
// ============================================================
export default function CreateCourierScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState(null);
  const [posInfo, setPosInfo] = useState({ isPos: false, printer: null });

  const [senderName, setSenderName] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [typeId, setTypeId] = useState(null);
  const [quantity, setQuantity] = useState('1');
  const [receivingAt, setReceivingAt] = useState('');
  const [partnerId, setPartnerId] = useState(null);
  const [sendDate, setSendDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [sendingTime, setSendingTime] = useState('');
  const [note, setNote] = useState('');
  const [price, setPrice] = useState('0');
  const [amount, setAmount] = useState('0');

  // ---------- Load form + detect POS ----------
  useEffect(() => {
    (async () => {
      try {
        if (Platform.OS === 'android') {
          try {
            await PermissionsAndroid.request(
              PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
            );
            if (Platform.Version >= 31) {
              await PermissionsAndroid.request(
                PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
              );
            }
          } catch (_) {}
        }

        const pos = await detectPosDevice();
        setPosInfo({ isPos: pos.isPos, printer: pos.printer });

        const raw = await authFetch('courier_form_data.php');
        let data = raw;
        if (data && typeof data.json === 'function') data = await data.json();
        if (data && data.data && !data.types) data = data.data;
        if (!data || !data.types) {
          throw new Error('Invalid form data response');
        }

        setFormData(data);
        if (data.types.length) setTypeId(data.types[0].id);
        if (data.partners?.length) setPartnerId(data.partners[0].id);
        if (data.schedules?.length) setSendingTime(data.schedules[0].time);
      } catch (e) {
        console.error('Load error:', e);
        Alert.alert('Error', e.message || 'Failed to load form data');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ---------- Recompute price ----------
  useEffect(() => {
    if (!formData || !typeId) return;
    const t = formData.types.find((x) => x.id === typeId);
    if (!t) return;
    const qty = parseFloat(quantity) || 1;
    setPrice(t.base_price.toFixed(0));
    setAmount((t.base_price * qty).toFixed(0));
  }, [typeId, quantity, formData]);

  // ---------- Submit ----------
  const handleSubmit = async () => {
    if (
      !senderName.trim() ||
      !senderPhone.trim() ||
      !recipientName.trim() ||
      !recipientPhone.trim()
    ) {
      Alert.alert('Missing fields', 'Please fill sender and recipient details');
      return;
    }
    if (!receivingAt.trim()) {
      Alert.alert('Missing destination', 'Please enter destination address');
      return;
    }
    if (!sendDate || sendDate < new Date().toISOString().slice(0, 10)) {
      Alert.alert('Invalid date', 'Send date cannot be in the past.');
      return;
    }

    setSubmitting(true);
    try {
      // Re-check POS on every submit (Bluetooth state may have changed)
      const pos = await detectPosDevice();
      console.log('📱 isPos:', pos.isPos, 'printer:', pos.printer?.name);

      const res = await authFetch('create_courier.php', {
        method: 'POST',
        body: JSON.stringify({
          sending_from: formData?.default_location?.id || null,
          sender_name: senderName.trim(),
          sender_phone: senderPhone.trim(),
          recipient_name: recipientName.trim(),
          recipient_phone: recipientPhone.trim(),
          type_id: typeId,
          price,
          quantity,
          amount,
          receiving_at: receivingAt.trim(),
          partner_id: partnerId,
          send_date: sendDate,
          sending_time: sendingTime,
          note: note.trim(),
        }),
      });

      console.log('CREATE COURIER RAW:', JSON.stringify(res));

      const { courier, sms } = await normalizeCourierResponse(res);
      const code = courier.courier_id || courier.tracking || courier.id;
      console.log('✅ Courier created:', code, 'SMS:', sms);

      // Build receipt object from server response
      const receipt = {
        id: courier.id,
        courierCode: code,
        tracking: courier.tracking || code,
        fromLocation: courier.location_name || courier.slocation || '-',
        senderName: courier.sender_name || senderName,
        senderPhone: courier.sender_phone || senderPhone,
        recipientName: courier.recipient_name || recipientName,
        recipientPhone: courier.recipient_phone || recipientPhone,
        destination:
          courier.receiving_at || courier.rlocation || receivingAt || '-',
        typeName: courier.type_name || '-',
        price: parseFloat(courier.price || 0).toLocaleString(),
        quantity: courier.quantity || '1',
        amount: parseFloat(courier.amount || 0).toLocaleString(),
        sendDate: courier.send_date || sendDate,
        sentTime: courier.sent_time || sendingTime,
        note: courier.note || '-',
        fullname: courier.created_by_name || courier.fullname || '',
        createdAt: courier.created_at || new Date().toISOString(),
        qrContent: `https://flashcourier.co.rw/reactflash/scan_invoice.php?invoice=${courier.id}`,
        barcodeContent: String(courier.tracking || courier.id),
      };

      // ---------- POS vs phone ----------
      if (pos.isPos) {
        if (!pos.printer) {
          Alert.alert(
            'Printer Not Found',
            'This is a POS, but "vbprinter" is not paired. Pair it in Settings → Bluetooth, then retry.',
            [{ text: 'OK', onPress: () => navigation.replace('Dashboard') }]
          );
        } else {
          const result = await printSilently(receipt, pos.printer);
          if (result.success) {
            Alert.alert('Success', `Courier ${code} created & printed.`, [
              { text: 'OK', onPress: () => navigation.replace('Dashboard') },
            ]);
          } else {
            Alert.alert(
              'Print Failed',
              result.error || 'Could not print receipt.',
              [{ text: 'OK', onPress: () => navigation.replace('Dashboard') }]
            );
          }
        }
      } else {
        Alert.alert('Success', `Courier ${code} created.`, [
          { text: 'OK', onPress: () => navigation.replace('Dashboard') },
        ]);
      }

      // Reset form
      setSenderName('');
      setSenderPhone('');
      setRecipientName('');
      setRecipientPhone('');
      setReceivingAt('');
      setNote('');
      setQuantity('1');
      setSendDate(new Date().toISOString().slice(0, 10));
    } catch (e) {
      console.error('Create courier error:', e);
      Alert.alert('Failed to create courier', e.message || 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- Loading ----------
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#008c8c" />
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  // ---------- Error ----------
  if (!formData) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Failed to load form data</Text>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={{ color: '#008c8c', marginTop: 20 }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  // ---------- Form ----------
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>New Courier</Text>
        {posInfo.isPos && (
          <Text style={styles.posBadge}>
            {posInfo.printer ? '🖨️ POS' : '⚠️ POS (no printer)'}
          </Text>
        )}
      </View>

      <Text style={styles.section}>Sender</Text>
      <TextInput
        style={styles.input}
        placeholder="Sender full name *"
        placeholderTextColor="#999"
        value={senderName}
        onChangeText={setSenderName}
      />
      <TextInput
        style={styles.input}
        placeholder="Sender phone *"
        placeholderTextColor="#999"
        keyboardType="phone-pad"
        value={senderPhone}
        onChangeText={setSenderPhone}
      />

      <Text style={styles.section}>Recipient</Text>
      <TextInput
        style={styles.input}
        placeholder="Recipient full name *"
        placeholderTextColor="#999"
        value={recipientName}
        onChangeText={setRecipientName}
      />
      <TextInput
        style={styles.input}
        placeholder="Recipient phone *"
        placeholderTextColor="#999"
        keyboardType="phone-pad"
        value={recipientPhone}
        onChangeText={setRecipientPhone}
      />

      <Text style={styles.section}>Destination</Text>
      <TextInput
        style={styles.input}
        placeholder="Destination address (mandatory) *"
        placeholderTextColor="#999"
        value={receivingAt}
        onChangeText={setReceivingAt}
      />

      <Text style={styles.section}>Courier Type</Text>
      <View style={styles.optionsGrid}>
        {formData.types.map((t) => (
          <Pressable
            key={t.id}
            style={[
              styles.optionBtn,
              typeId === t.id && styles.optionBtnActive,
            ]}
            onPress={() => setTypeId(t.id)}
          >
            <Text
              style={[
                styles.optionText,
                typeId === t.id && styles.optionTextActive,
              ]}
            >
              {t.type_name}
            </Text>
            <Text
              style={[
                styles.optionPrice,
                typeId === t.id && styles.optionTextActive,
              ]}
            >
              {t.base_price.toLocaleString()} RWF
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>Quantity</Text>
      <TextInput
        style={styles.input}
        placeholder="1"
        placeholderTextColor="#999"
        keyboardType="number-pad"
        value={quantity}
        onChangeText={setQuantity}
      />

      <View style={styles.summary}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Unit price</Text>
          <Text style={styles.summaryValue}>
            {parseFloat(price).toLocaleString()} RWF
          </Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Quantity</Text>
          <Text style={styles.summaryValue}>{quantity}</Text>
        </View>
        <View style={[styles.summaryRow, styles.summaryTotal]}>
          <Text style={styles.summaryTotalLabel}>Total</Text>
          <Text style={styles.summaryTotalValue}>
            {parseFloat(amount).toLocaleString()} RWF
          </Text>
        </View>
      </View>

      <Text style={styles.section}>Carrier Partner</Text>
      <View style={styles.optionsGrid}>
        {formData.partners.map((p) => (
          <Pressable
            key={p.id}
            style={[
              styles.optionBtn,
              partnerId === p.id && styles.optionBtnActive,
            ]}
            onPress={() => setPartnerId(p.id)}
          >
            <Text
              style={[
                styles.optionText,
                partnerId === p.id && styles.optionTextActive,
              ]}
            >
              {p.partner_name}
            </Text>
            <Text
              style={[
                styles.optionPrice,
                partnerId === p.id && styles.optionTextActive,
              ]}
            >
              {p.transport_type}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>Send Date</Text>
      <TextInput
        style={styles.input}
        placeholder="YYYY-MM-DD"
        placeholderTextColor="#999"
        value={sendDate}
        onChangeText={setSendDate}
      />

      <Text style={styles.section}>Sending Time</Text>
      <View style={styles.optionsGrid}>
        {formData.schedules.map((s) => (
          <Pressable
            key={s.id}
            style={[
              styles.optionBtn,
              sendingTime === s.time && styles.optionBtnActive,
            ]}
            onPress={() => setSendingTime(s.time)}
          >
            <Text
              style={[
                styles.optionText,
                sendingTime === s.time && styles.optionTextActive,
              ]}
            >
              {s.time}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>Note (optional)</Text>
      <TextInput
        style={[styles.input, styles.textArea]}
        placeholder="Any additional notes..."
        placeholderTextColor="#999"
        multiline
        numberOfLines={3}
        value={note}
        onChangeText={setNote}
      />

      <Pressable
        style={({ pressed }) => [
          styles.submitBtn,
          pressed && styles.submitBtnPressed,
          submitting && styles.submitBtnDisabled,
        ]}
        onPress={handleSubmit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>
            {posInfo.isPos ? 'Create & Print' : 'Create Courier'}
          </Text>
        )}
      </Pressable>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 20, paddingTop: 40, paddingBottom: 60 },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f7fa',
  },
  loadingText: { marginTop: 12, color: '#666' },
  errorText: { color: '#c0392b', fontSize: 16 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  backBtn: { color: '#008c8c', fontSize: 15, fontWeight: '600', marginRight: 16 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#222', flex: 1 },
  posBadge: {
    fontSize: 12,
    fontWeight: '700',
    color: '#008c8c',
    backgroundColor: '#e6f4f4',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  section: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginTop: 16,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 10,
    color: '#222',
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  optionsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  optionBtn: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginRight: 8,
    marginBottom: 8,
    minWidth: 100,
  },
  optionBtnActive: { backgroundColor: '#008c8c', borderColor: '#008c8c' },
  optionText: { fontSize: 13, fontWeight: '600', color: '#333' },
  optionPrice: { fontSize: 11, color: '#888', marginTop: 2 },
  optionTextActive: { color: '#fff' },
  summary: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 10,
    marginTop: 8,
    marginBottom: 8,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  summaryLabel: { fontSize: 14, color: '#666' },
  summaryValue: { fontSize: 14, fontWeight: '600', color: '#333' },
  summaryTotal: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    marginTop: 6,
    paddingTop: 10,
  },
  summaryTotalLabel: { fontSize: 16, fontWeight: '700', color: '#333' },
  summaryTotalValue: { fontSize: 18, fontWeight: 'bold', color: '#008c8c' },
  submitBtn: {
    backgroundColor: '#008c8c',
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 24,
  },
  submitBtnPressed: { backgroundColor: '#006e6e' },
  submitBtnDisabled: { opacity: 0.6 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});