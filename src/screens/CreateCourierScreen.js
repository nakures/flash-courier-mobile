import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';

import {
  View,
  Text,
  Image,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
  PermissionsAndroid,
  KeyboardAvoidingView,
} from 'react-native';

import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';

import RNBluetoothClassic from 'react-native-bluetooth-classic';

import ThermalPrinter, { image } from 'react-native-thermal-printer-driver';

import { authFetch } from '../services/api';

import { Buffer } from 'buffer';

// ============================================================
// CONFIGURATION
// ============================================================

const API_FORM = 'courier_form_data.php';
const API_CREATE = 'create_courier.php';

const PRINTER_TIMEOUT = 20000;
const DISCOVERY_TIMEOUT = 8000;
const LOGO_TIMEOUT = 30000;

const PRINTER_NAME_HINT = 'VBTPRINTER';
const CHARS_PER_LINE = 32;

// ============================================================
// DATE / TIME HELPERS
// ============================================================

const pad2 = (n) => String(n).padStart(2, '0');

const getLocalDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const normalizeCalendarDate = (value) => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [year, month, day] = trimmed.split('-').map(Number);
  if (year < 1900 || year > 2999 || month < 1 || month > 12) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return null;
  return trimmed;
};

const dateToString = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const timeToString = (date) =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

const stringToDate = (value) => {
  if (!value) return new Date();
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
};

const stringToTime = (value) => {
  if (!value) return new Date();
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) return new Date();
  const result = new Date();
  result.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return result;
};

const formatMoney = (value) => Number(value || 0).toLocaleString('en-US');

const normalizeId = (value) => String(value ?? '');

const formatTimeForDisplay = (value) => {
  if (!value) return 'Select sending time';
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) return value;
  const hours = Number(match[1]);
  const minutes = match[2];
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${minutes} ${suffix}`;
};

// ============================================================
// BLUETOOTH PERMISSIONS
// ============================================================

const requestBluetoothPermissions = async () => {
  if (Platform.OS !== 'android') {
    throw new Error('Bluetooth printing is only available on Android.');
  }
  const sdkInt = Number(Platform.Version) || 0;
  if (sdkInt >= 31) {
    const perms = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    ].filter(Boolean);
    const results = await PermissionsAndroid.requestMultiple(perms);
    const allGranted = perms.every(
      (p) => results[p] === PermissionsAndroid.RESULTS.GRANTED
    );
    if (!allGranted) {
      throw new Error(
        'Bluetooth permission denied. Enable Nearby Devices access in Android settings.'
      );
    }
  } else {
    const perm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
    if (perm) {
      const result = await PermissionsAndroid.request(perm);
      if (result !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error('Location permission is required for Bluetooth access.');
      }
    }
  }
  return true;
};

// ============================================================
// TIMEOUT WRAPPER
// ============================================================

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);

// ============================================================
// ESC/POS BYTE BUILDERS
// ============================================================

const LF_BYTE = 0x0A;
const ESC = 0x1B;
const GS = 0x1D;

const INIT_BYTES = [ESC, 0x40]; // ESC @
const ALIGN_LFT = [ESC, 0x61, 0x00]; // ESC a 0
const ALIGN_CTR = [ESC, 0x61, 0x01]; // ESC a 1
const BOLD_ON = [ESC, 0x45, 0x01]; // ESC E 1
const BOLD_OFF = [ESC, 0x45, 0x00]; // ESC E 0
const SIZE_DBL = [GS, 0x21, 0x11]; // GS ! 17
const SIZE_NRM = [GS, 0x21, 0x00]; // GS ! 0
const FEED = [ESC, 0x64, 0x03]; // ESC d 3
const CUT = [GS, 0x56, 0x41, 0x03]; // GS V A 3

// Convert ASCII string to byte array. Non-ASCII chars (>127) are replaced with '?'.
const asciiBytes = (str) => {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out.push(code <= 0x7F ? code : 0x3F); // '?' for non-ASCII
  }
  return out;
};

// Concatenate multiple byte arrays
const concatBytes = (...arrays) => {
  const out = [];
  for (const arr of arrays) {
    for (const b of arr) out.push(b);
  }
  return out;
};

const separatorBytes = () =>
  asciiBytes('-'.repeat(CHARS_PER_LINE) + '\n');

const padRowBytes = (label, value) => {
  const l = String(label);
  const r = String(value);
  const dots = Math.max(1, CHARS_PER_LINE - l.length - r.length);
  return asciiBytes(l + '.'.repeat(dots) + r + '\n');
};

// ---------- QR CODE: native GS ( k, Model 2 ----------
const qrBytes = (data, moduleSize = 6, ecByte = 0x31) => {
  const payload = asciiBytes(String(data));
  const len = payload.length + 3;
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;

  return concatBytes(
    [GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00], // model 2
    [GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, moduleSize], // module size
    [GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, ecByte], // EC level M
    [GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30], // store data header
    payload,
    [GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30] // print
  );
};

// ---------- BARCODE: native GS k m=73 (CODE128 fn B) ----------
const code128Bytes = (data) => {
  const text = asciiBytes(String(data));
  return concatBytes(
    [GS, 0x68, 0x50], // GS h 80 (height)
    [GS, 0x77, 0x02], // GS w 2 (width)
    [GS, 0x48, 0x02], // GS H 2 (HRI below)
    [GS, 0x66, 0x00], // GS f 0 (font A)
    [GS, 0x6B, 0x49, text.length], // GS k 73 len
    text
  );
};

// ---------- RECEIPT LOGO (PNG -> ESC/POS MONOCHROME RASTER) ----------
// Uses the installed thermal-printer-driver image renderer. The printer's
// existing Bluetooth Classic socket is briefly released for image rendering,
// then restored so the existing raw ESC/POS receipt/QR/barcode flow remains.
const printLogoRaster = async (printer) => {
  const source = Image.resolveAssetSource(require('../../assets/logo.png'));
  if (!source?.uri) throw new Error('Receipt logo asset could not be resolved.');

  const driverAddress = `bt:${printer.address}`;
  let wasClassicConnected = false;
  try {
    wasClassicConnected = await RNBluetoothClassic.isDeviceConnected(printer.address);
    if (wasClassicConnected) {
      await RNBluetoothClassic.disconnectFromDevice(printer.address);
    }

    await ThermalPrinter.connect(driverAddress, { timeout: 12000 });
    await ThermalPrinter.print(
      driverAddress,
      [image({ uri: source.uri, width: 384 })],
      {
        paperWidthMm: 58,
        timeout: LOGO_TIMEOUT,
        keepAlive: false,
        disableCutPaper: true,
      }
    );
  } finally {
    try {
      await ThermalPrinter.disconnect(driverAddress);
    } catch (_) {}

    if (wasClassicConnected) {
      await RNBluetoothClassic.connectToDevice(printer.address, {
        CONNECTOR_TYPE: 'rfcomm',
        CONNECTION_TYPE: 'binary',
        SECURE_SOCKET: false,
      });
    }
  }
};

// ============================================================
// PRINTER DISCOVERY
// ============================================================

const discoverPrinters = async () => {
  await requestBluetoothPermissions();
  const bonded = await withTimeout(
    RNBluetoothClassic.getBondedDevices(),
    DISCOVERY_TIMEOUT,
    'Printer scan'
  );
  if (!Array.isArray(bonded)) return [];

  const sorted = [...bonded].sort((a, b) => {
    const an = (a.name || '').toUpperCase();
    const bn = (b.name || '').toUpperCase();
    const aScore = an.includes(PRINTER_NAME_HINT) ? 0 : an.includes('PRINTER') ? 1 : 2;
    const bScore = bn.includes(PRINTER_NAME_HINT) ? 0 : bn.includes('PRINTER') ? 1 : 2;
    return aScore - bScore;
  });

  return sorted.map((d) => ({
    id: d.address,
    address: d.address,
    name: d.name || 'Unknown device',
    deviceName: d.name || 'Unknown device',
  }));
};

// ============================================================
// PRINT RECEIPT (QR + BARCODE guaranteed)
// ============================================================

const printReceipt = async (receipt, printer) => {
  let address = null;
  let connected = false;

  try {
    if (!printer || !printer.address) {
      throw new Error('Please select a printer first.');
    }

    address = printer.address;

    await requestBluetoothPermissions();

    // Connect over Classic Bluetooth SPP (RFCOMM).
    // IMPORTANT: do NOT specify DEVICE_CHARSET here. We'll send base64.
    const already = await RNBluetoothClassic.isDeviceConnected(address);
    if (!already) {
      await withTimeout(
        RNBluetoothClassic.connectToDevice(address, {
          CONNECTOR_TYPE: 'rfcomm',
          CONNECTION_TYPE: 'binary',
          SECURE_SOCKET: false,
        }),
        PRINTER_TIMEOUT,
        'Printer connect'
      );
    }

    connected = true;

    // Hermes natively supports base64 encoding.
    // We convert our byte arrays to base64 before sending.
    const write = async (bytesOrArray) => {
      const bytes = Array.isArray(bytesOrArray) ? bytesOrArray : [bytesOrArray];
      // Buffer is accepted by react-native-bluetooth-classic and is
      // transported as Base64 internally by the native bridge.
      const payload = Buffer.from(bytes);
      const written = await RNBluetoothClassic.writeToDevice(address, payload);
      if (written !== true) {
        throw new Error('Bluetooth printer did not accept the data.');
      }
      return true;
    };

    // ---------- 1. Logo (optional) ----------
    try {
      await withTimeout(printLogoRaster(printer), LOGO_TIMEOUT, 'Print logo');
    } catch (_) {
      /* logo is optional */
    }

    // ---------- 2. Initialize + header ----------
    await write(concatBytes(
      INIT_BYTES,
      ALIGN_CTR,
      BOLD_ON,
      SIZE_DBL,
      asciiBytes('FLASH COURIER\n'),
      SIZE_NRM,
      BOLD_OFF,
      separatorBytes()
    ));

    // ---------- 3. Large courier code ----------
    await write(concatBytes(
      ALIGN_CTR,
      BOLD_ON,
      SIZE_DBL,
      asciiBytes(`${receipt.courierCode}\n`),
      SIZE_NRM,
      BOLD_OFF
    ));

    // ---------- 4. Body ----------
    let body = [];
    body = body.concat(ALIGN_LFT);
    body = body.concat(padRowBytes('TRACKING', receipt.tracking));
    body = body.concat(padRowBytes('SEND DATE', receipt.sendDate));
    body = body.concat(padRowBytes('SEND TIME', receipt.sentTime));
    body = body.concat(padRowBytes('CREATED', receipt.createdAt));
    body = body.concat(separatorBytes());
    body = body.concat(asciiBytes('SENDER INFORMATION\n'));
    body = body.concat(padRowBytes('Name', receipt.senderName));
    body = body.concat(padRowBytes('Phone', receipt.senderPhone));
    body = body.concat(padRowBytes('From', receipt.fromLocation));
    body = body.concat(separatorBytes());
    body = body.concat(asciiBytes('RECIPIENT INFORMATION\n'));
    body = body.concat(padRowBytes('Name', receipt.recipientName));
    body = body.concat(padRowBytes('Phone', receipt.recipientPhone));
    body = body.concat(padRowBytes('Dest', receipt.destination));
    body = body.concat(separatorBytes());
    body = body.concat(asciiBytes('COURIER DETAILS\n'));
    body = body.concat(padRowBytes('Type', receipt.typeName));
    body = body.concat(padRowBytes('Unit', `${receipt.price} RWF`));
    body = body.concat(padRowBytes('Qty', receipt.quantity));
    body = body.concat(padRowBytes('Served by', receipt.fullname || '-'));
    body = body.concat(padRowBytes('Note', receipt.note || '-'));
    body = body.concat(separatorBytes());
    body = body.concat(BOLD_ON);
    body = body.concat(asciiBytes(`TOTAL: ${receipt.amount} RWF\n`));
    body = body.concat(BOLD_OFF);
    body = body.concat(separatorBytes());
    await write(body);

    // ---------- 5. QR CODE ----------
    const trackUrl = `https://flashcourier.co.rw/reactflash/scan_invoice.php?invoice=${receipt.id}`;
    await write(concatBytes(ALIGN_CTR, asciiBytes('SCAN TO TRACK\n')));
    await withTimeout(
      write(qrBytes(trackUrl, 6)),
      PRINTER_TIMEOUT,
      'Print QR'
    );
    await write([LF_BYTE]);

    // ---------- 6. BARCODE ----------
    await write(concatBytes(ALIGN_CTR, asciiBytes('COURIER CODE\n')));
    await withTimeout(
      write(code128Bytes(receipt.courierCode)),
      PRINTER_TIMEOUT,
      'Print barcode'
    );
    await write([LF_BYTE]);

    // ---------- 7. Footer + cut ----------
    await write(concatBytes(
      ALIGN_CTR,
      asciiBytes('\nThank you for choosing FLASH COURIER!\n'),
      FEED,
      CUT
    ));

    return { success: true, error: null };
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Unknown printing error.',
    };
  } finally {
    if (connected && address) {
      try {
        await RNBluetoothClassic.disconnectFromDevice(address);
      } catch (_) {
        /* swallow */
      }
    }
  }
};

// ============================================================
// NORMALIZE SERVER RESPONSE
// ============================================================

const normalizeCourierResponse = async (response) => {
  let body = response;
  if (body && typeof body.json === 'function') {
    if (body.ok === false) {
      throw new Error(`Server error: HTTP ${body.status || 'unknown'}`);
    }
    body = await body.json();
  }
  if (!body || typeof body !== 'object') {
    throw new Error('Empty server response.');
  }
  const candidates = [body.courier, body.data?.courier, body.data, body.result, body];
  let courier = null;
  for (const c of candidates) {
    if (c && typeof c === 'object' && (c.courier_id || c.id || c.tracking)) {
      courier = c;
      break;
    }
  }
  if (body.ok === false || body.success === false || (body.error && !courier)) {
    throw new Error(body.error || body.message || 'Server rejected courier creation.');
  }
  if (!courier) {
    throw new Error(
      'No courier information returned by server: ' +
        JSON.stringify(body).slice(0, 300)
    );
  }
  const sms =
    body.sms?.status || body.sms ||
    courier.sms?.status || courier.sms || null;
  return {
    courier: {
      ...courier,
      id: courier.id || courier.courier_id || courier.tracking,
    },
    sms,
  };
};

// ============================================================
// MAIN SCREEN
// ============================================================

export default function CreateCourierScreen({ navigation }) {
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);

  const [formData, setFormData] = useState(null);
  const [senderName, setSenderName] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [typeId, setTypeId] = useState(null);
  const [quantity, setQuantity] = useState('1');
  const [receivingAt, setReceivingAt] = useState('');
  const [partnerId, setPartnerId] = useState(null);
  const [sendDate, setSendDate] = useState(getLocalDate());
  const [sendingTime, setSendingTime] = useState('');
  const [note, setNote] = useState('');
  const [price, setPrice] = useState('0');
  const [amount, setAmount] = useState('0');
  const [printers, setPrinters] = useState([]);
  const [selectedPrinter, setSelectedPrinter] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [showIOSDatePicker, setShowIOSDatePicker] = useState(false);
  const [showIOSTimePicker, setShowIOSTimePicker] = useState(false);

  const safeSet = useCallback((setter, value) => {
    if (mountedRef.current) setter(value);
  }, []);

  const openDatePicker = useCallback(() => {
    const currentDate = stringToDate(sendDate);
    const minimumDate = new Date();
    minimumDate.setHours(0, 0, 0, 0);
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: currentDate,
        mode: 'date',
        display: 'calendar',
        minimumDate,
        onChange: (event, selectedDate) => {
          if (event.type === 'set' && selectedDate) {
            safeSet(setSendDate, dateToString(selectedDate));
          }
        },
      });
    } else {
      setShowIOSDatePicker(true);
    }
  }, [sendDate, safeSet]);

  const openTimePicker = useCallback(() => {
    const currentTime = stringToTime(sendingTime);
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: currentTime,
        mode: 'time',
        display: 'clock',
        is24Hour: true,
        onChange: (event, selectedDate) => {
          if (event.type === 'set' && selectedDate) {
            safeSet(setSendingTime, timeToString(selectedDate));
          }
        },
      });
    } else {
      setShowIOSTimePicker(true);
    }
  }, [sendingTime, safeSet]);

  const handleDiscoverPrinters = useCallback(async () => {
    if (discovering || !mountedRef.current) return;
    safeSet(setDiscovering, true);
    try {
      const devices = await discoverPrinters();
      if (!mountedRef.current) return;
      safeSet(setPrinters, devices);
      if (devices.length === 0) {
        Alert.alert(
          'No Printers Found',
          'No paired Bluetooth devices were found.\n\n' +
            'Open Android Bluetooth settings and pair the Q2i printer (VBTPRINTER), then try again.',
          [{ text: 'OK' }],
          { cancelable: false }
        );
        return;
      }
      const firstPrinter = devices[0];
      safeSet(setSelectedPrinter, firstPrinter);
      Alert.alert(
        'Printer Discovery',
        `${devices.length} paired Bluetooth device(s) found.\n\n` +
          `Auto-selected: ${firstPrinter.name}\n` +
          `${firstPrinter.address}`,
        [{ text: 'OK' }],
        { cancelable: false }
      );
    } catch (error) {
      if (!mountedRef.current) return;
      Alert.alert(
        'Printer Discovery Failed',
        error.message || 'Unable to discover printers.',
        [{ text: 'OK' }],
        { cancelable: false }
      );
    } finally {
      if (mountedRef.current) safeSet(setDiscovering, false);
    }
  }, [discovering, safeSet]);

  const loadFormData = useCallback(async () => {
    safeSet(setLoading, true);
    try {
      const raw = await authFetch(API_FORM);
      let data = raw;
      if (data && typeof data.json === 'function') {
        if (data.ok === false) {
          throw new Error(`Failed to load form data. HTTP ${data.status}`);
        }
        data = await data.json();
      }
      if (data?.data && !data.types) data = data.data;
      if (!data || !Array.isArray(data.types)) {
        throw new Error('Invalid server response: courier types are missing.');
      }
      data.partners = Array.isArray(data.partners) ? data.partners : [];
      if (!mountedRef.current) return;
      setFormData(data);
      if (data.types.length > 0) setTypeId(data.types[0].id);
      if (data.partners.length > 0) setPartnerId(data.partners[0].id);
      setSendingTime('');
    } catch (error) {
      if (!mountedRef.current) return;
      Alert.alert(
        'Loading Error',
        error.message || 'Unable to load courier form.',
        [{ text: 'OK' }],
        { cancelable: false }
      );
    } finally {
      if (mountedRef.current) safeSet(setLoading, false);
    }
  }, [safeSet]);

  useEffect(() => {
    loadFormData();
  }, [loadFormData]);

  useEffect(() => {
    if (!formData || !typeId) {
      setPrice('0');
      setAmount('0');
      return;
    }
    const selectedType = formData.types.find(
      (item) => normalizeId(item.id) === normalizeId(typeId)
    );
    if (!selectedType) return;
    const unitPrice = Number(selectedType.base_price) || 0;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    setPrice(String(unitPrice));
    setAmount(String(unitPrice * qty));
  }, [typeId, quantity, formData]);

  const resetForm = useCallback(() => {
    setSenderName('');
    setSenderPhone('');
    setRecipientName('');
    setRecipientPhone('');
    setReceivingAt('');
    setNote('');
    setQuantity('1');
    setSendDate(getLocalDate());
    setSendingTime('');
    if (formData?.types?.length) setTypeId(formData.types[0].id);
    if (formData?.partners?.length) setPartnerId(formData.partners[0].id);
  }, [formData]);

  const validateForm = useCallback(() => {
    const fail = (title, msg) => {
      Alert.alert(title, msg, [{ text: 'OK' }], { cancelable: false });
      return false;
    };
    if (!senderName.trim()) return fail('Missing Information', 'Enter sender full name.');
    if (!senderPhone.trim()) return fail('Missing Information', 'Enter sender phone number.');
    if (!recipientName.trim()) return fail('Missing Information', 'Enter recipient full name.');
    if (!recipientPhone.trim()) return fail('Missing Information', 'Enter recipient phone number.');
    if (!receivingAt.trim()) return fail('Missing Destination', 'Enter destination address.');
    if (!typeId) return fail('Missing Information', 'Select courier type.');
    if (!quantity.trim() || !/^\d+$/.test(quantity) || parseInt(quantity, 10) < 1) {
      return fail('Invalid Quantity', 'Quantity must be a positive whole number.');
    }
    const normalizedSendDate = normalizeCalendarDate(sendDate);
    if (!normalizedSendDate) return fail('Invalid Date', 'Please select a valid calendar date.');
    if (normalizedSendDate < getLocalDate()) return fail('Invalid Date', 'Send date cannot be in the past.');
    if (!sendingTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(sendingTime)) {
      return fail('Missing Sending Time', 'Please tap the clock field and select the sending time.');
    }
    if (!formData?.default_location?.id) {
      return fail('Missing Location', 'Default sending location is not configured.');
    }
    if (!formData.types.some((i) => normalizeId(i.id) === normalizeId(typeId))) {
      return fail('Invalid Courier Type', 'Select a valid courier type.');
    }
    if (
      formData.partners.length > 0 &&
      !formData.partners.some((i) => normalizeId(i.id) === normalizeId(partnerId))
    ) {
      return fail('Invalid Partner', 'Select a valid carrier partner.');
    }
    return true;
  }, [
    senderName, senderPhone, recipientName, recipientPhone,
    receivingAt, typeId, quantity, sendDate, sendingTime,
    partnerId, formData,
  ]);

  const buildReceipt = useCallback(
    (courier) => {
      const code = courier.courier_id || courier.tracking || courier.id;
      const courierId = courier.id || courier.courier_id;
      const selectedType = formData.types.find(
        (i) => normalizeId(i.id) === normalizeId(typeId)
      );
      return {
        id: courierId,
        courierCode: String(code),
        tracking: String(courier.tracking || code),
        fromLocation:
          courier.location_name ||
          courier.slocation ||
          formData.default_location?.location_name ||
          formData.default_location?.name ||
          '-',
        senderName: courier.sender_name || senderName,
        senderPhone: courier.sender_phone || senderPhone,
        recipientName: courier.recipient_name || recipientName,
        recipientPhone: courier.recipient_phone || recipientPhone,
        destination: courier.receiving_at || courier.rlocation || receivingAt || '-',
        typeName: courier.type_name || selectedType?.type_name || '-',
        price: formatMoney(courier.price ?? price),
        quantity: courier.quantity || quantity,
        amount: formatMoney(courier.amount ?? amount),
        sendDate: courier.send_date || sendDate,
        sentTime: courier.sent_time || sendingTime || '-',
        note: courier.note || note || '-',
        fullname: courier.created_by_name || courier.fullname || '',
        createdAt: courier.created_at || new Date().toLocaleString(),
      };
    },
    [
      formData, typeId, senderName, senderPhone, recipientName,
      recipientPhone, receivingAt, price, quantity, amount,
      sendDate, sendingTime, note,
    ]
  );

  const handleSubmit = useCallback(async () => {
    if (submitLock.current || submitting) return;
    if (!validateForm()) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      const response = await authFetch(API_CREATE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sending_from: formData.default_location.id,
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
          send_date: normalizeCalendarDate(sendDate),
          sending_time: sendingTime,
          note: note.trim(),
        }),
      });
      const { courier } = await normalizeCourierResponse(response);
      const code = courier.courier_id || courier.tracking || courier.id;
      const receipt = buildReceipt(courier);

      if (selectedPrinter) {
        setPrinting(true);
        const printResult = await printReceipt(receipt, selectedPrinter);
        setPrinting(false);
        resetForm();
        if (printResult.success) {
          Alert.alert(
            'Courier Created Successfully',
            `Courier: ${code}\n\nReceipt with QR and barcode printed successfully.`,
            [{ text: 'OK', onPress: () => navigation.replace('Dashboard') }],
            { cancelable: false }
          );
        } else {
          Alert.alert(
            'Courier Created - Printing Failed',
            `Courier: ${code}\n\nThe courier was saved, but the receipt could not be printed.\n\n` +
              `Reason: ${printResult.error}\n\nYou can print again from courier records.`,
            [{ text: 'OK', onPress: () => navigation.replace('Dashboard') }],
            { cancelable: false }
          );
        }
      } else {
        resetForm();
        Alert.alert(
          'Courier Created',
          `Courier ${code} created successfully.\n\nNo printer was selected, so no receipt was printed.`,
          [{ text: 'OK', onPress: () => navigation.replace('Dashboard') }],
          { cancelable: false }
        );
      }
    } catch (error) {
      if (mountedRef.current) {
        setPrinting(false);
        Alert.alert(
          'Courier Creation Failed',
          error.message || 'An unexpected error occurred.',
          [{ text: 'OK' }],
          { cancelable: false }
        );
      }
    } finally {
      submitLock.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
        setPrinting(false);
      }
    }
  }, [
    submitting, validateForm, formData, senderName, senderPhone,
    recipientName, recipientPhone, typeId, price, quantity, amount,
    receivingAt, partnerId, sendDate, sendingTime, note,
    selectedPrinter, buildReceipt, resetForm, navigation,
  ]);

  const printerOptions = useMemo(() => {
    return printers.map((p) => ({
      ...p,
      active: selectedPrinter?.id === p.id,
    }));
  }, [printers, selectedPrinter]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#008c8c" />
        <Text style={styles.loadingText}>Loading courier information...</Text>
      </View>
    );
  }

  if (!formData) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Failed to load courier form data.</Text>
        <Pressable style={styles.retryBtn} onPress={loadFormData}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={styles.backBtn}>← Back</Text>
          </Pressable>
        <Image
  source={require('../../assets/icon.png')}
  style={styles.headerLogo}
  resizeMode="contain"
  accessibilityLabel="Flash Courier logo"
/>
          <Text style={styles.title}>New Courier</Text>
          <Text style={styles.posBadge}>Q2i POS</Text>
        </View>

        {Platform.OS === 'android' && (
          <View style={styles.printerSection}>
            <Text style={styles.section}>ESC/POS Thermal Printer</Text>
            <Text style={styles.deviceText}>Device: Q2i Android POS</Text>

            <Pressable
              style={styles.discoverBtn}
              onPress={handleDiscoverPrinters}
              disabled={discovering}
            >
              {discovering ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.discoverText}>SEARCH FOR PRINTERS</Text>
              )}
            </Pressable>

            {printerOptions.length > 0 && (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.deviceText}>Available Bluetooth devices:</Text>
                {printerOptions.map((printer) => (
                  <Pressable
                    key={printer.id || printer.address}
                    style={[
                      styles.printerOption,
                      printer.active && styles.printerOptionActive,
                    ]}
                    onPress={() => setSelectedPrinter(printer)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          styles.optionText,
                          printer.active && styles.optionTextActive,
                        ]}
                      >
                        {printer.name || printer.deviceName || 'Unknown printer'}
                      </Text>
                      <Text
                        style={[
                          styles.printerAddress,
                          printer.active && styles.optionTextActive,
                        ]}
                      >
                        {printer.address || printer.macAddress}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.selectText,
                        printer.active && styles.optionTextActive,
                      ]}
                    >
                      {printer.active ? 'SELECTED' : 'SELECT'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Text style={styles.hint}>
              Pair the Q2i printer (VBTPRINTER) in Android Bluetooth settings before searching.
            </Text>
            <Text style={styles.selectedPrinter}>
              Selected: {selectedPrinter?.name || selectedPrinter?.deviceName || 'No printer selected'}
            </Text>
          </View>
        )}

        <Text style={styles.section}>Sender Information</Text>
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

        <Text style={styles.section}>Recipient Information</Text>
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
          placeholder="Destination address *"
          placeholderTextColor="#999"
          value={receivingAt}
          onChangeText={setReceivingAt}
        />

        <Text style={styles.section}>Courier Type</Text>
        <View style={styles.optionsGrid}>
          {formData.types.map((item) => {
            const active = normalizeId(typeId) === normalizeId(item.id);
            return (
              <Pressable
                key={item.id}
                style={[styles.optionBtn, active && styles.optionBtnActive]}
                onPress={() => setTypeId(item.id)}
              >
                <Text style={[styles.optionText, active && styles.optionTextActive]}>
                  {item.type_name}
                </Text>
                <Text style={[styles.optionPrice, active && styles.optionTextActive]}>
                  {formatMoney(item.base_price)} RWF
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>Quantity</Text>
        <TextInput
          style={styles.input}
          placeholder="Quantity"
          placeholderTextColor="#999"
          keyboardType="number-pad"
          value={quantity}
          onChangeText={(v) => setQuantity(v.replace(/[^0-9]/g, ''))}
        />

        <View style={styles.summary}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Unit Price</Text>
            <Text style={styles.summaryValue}>{formatMoney(price)} RWF</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Quantity</Text>
            <Text style={styles.summaryValue}>{quantity || '0'}</Text>
          </View>
          <View style={[styles.summaryRow, styles.summaryTotal]}>
            <Text style={styles.summaryTotalLabel}>TOTAL</Text>
            <Text style={styles.summaryTotalValue}>{formatMoney(amount)} RWF</Text>
          </View>
        </View>

        <Text style={styles.section}>Carrier Partner</Text>
        <View style={styles.optionsGrid}>
          {formData.partners.map((item) => {
            const active = normalizeId(partnerId) === normalizeId(item.id);
            return (
              <Pressable
                key={item.id}
                style={[styles.optionBtn, active && styles.optionBtnActive]}
                onPress={() => setPartnerId(item.id)}
              >
                <Text style={[styles.optionText, active && styles.optionTextActive]}>
                  {item.partner_name}
                </Text>
                <Text style={[styles.optionPrice, active && styles.optionTextActive]}>
                  {item.transport_type}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>Send Date</Text>
        <Pressable style={styles.pickerField} onPress={openDatePicker}>
          <Text style={styles.pickerIcon}>📅</Text>
          <Text style={styles.pickerValue}>{sendDate || 'Select sending date'}</Text>
          <Text style={styles.pickerAction}>CALENDAR</Text>
        </Pressable>

        {Platform.OS === 'ios' && showIOSDatePicker && (
          <DateTimePicker
            value={stringToDate(sendDate)}
            mode="date"
            display="inline"
            minimumDate={new Date()}
            onChange={(event, selectedDate) => {
              setShowIOSDatePicker(false);
              if (selectedDate) setSendDate(dateToString(selectedDate));
            }}
          />
        )}

        <Text style={styles.section}>Sending Time</Text>
        <Pressable style={styles.pickerField} onPress={openTimePicker}>
          <Text style={styles.pickerIcon}>🕒</Text>
          <Text style={styles.pickerValue}>
            {sendingTime ? formatTimeForDisplay(sendingTime) : 'Select sending time'}
          </Text>
          <Text style={styles.pickerAction}>CLOCK</Text>
        </Pressable>

        {Platform.OS === 'ios' && showIOSTimePicker && (
          <DateTimePicker
            value={stringToTime(sendingTime)}
            mode="time"
            display="spinner"
            is24Hour
            onChange={(event, selectedDate) => {
              setShowIOSTimePicker(false);
              if (selectedDate) setSendingTime(timeToString(selectedDate));
            }}
          />
        )}

        <Text style={styles.section}>Additional Note (Optional)</Text>
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
          {submitting || printing ? (
            <View style={styles.loadingButton}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.submitText}>
                {printing ? 'PRINTING RECEIPT...' : 'PROCESSING...'}
              </Text>
            </View>
          ) : (
            <Text style={styles.submitText}>
              {selectedPrinter ? 'CREATE & PRINT RECEIPT' : 'CREATE COURIER'}
            </Text>
          )}
        </Pressable>

        <View style={{ height: 50 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ============================================================
// STYLES
// ============================================================

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 20, paddingTop: 40, paddingBottom: 60 },
  center: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#f5f7fa', padding: 20,
  },
  loadingText: { marginTop: 12, color: '#666', fontSize: 14 },
  errorText: { color: '#c0392b', fontSize: 16, textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  headerLogo: { width: 42, height: 42, marginRight: 9 },
  backBtn: { color: '#008c8c', fontSize: 15, fontWeight: '600', marginRight: 16 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#222', flex: 1 },
  posBadge: {
    fontSize: 12, fontWeight: '700', color: '#008c8c',
    backgroundColor: '#e6f4f4', paddingHorizontal: 10,
    paddingVertical: 5, borderRadius: 6,
  },
  printerSection: {
    backgroundColor: '#fff', padding: 14, borderRadius: 10,
    marginBottom: 12, borderWidth: 1, borderColor: '#ddd',
  },
  deviceText: { fontSize: 12, color: '#555', marginBottom: 8 },
  discoverBtn: {
    backgroundColor: '#008c8c', paddingVertical: 13,
    borderRadius: 8, alignItems: 'center',
  },
  discoverText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  printerOption: {
    flexDirection: 'row', alignItems: 'center', padding: 12,
    borderRadius: 8, borderWidth: 1, borderColor: '#ddd', marginBottom: 8,
  },
  printerOptionActive: { backgroundColor: '#008c8c', borderColor: '#008c8c' },
  printerAddress: { fontSize: 11, color: '#888', marginTop: 3 },
  selectText: { color: '#008c8c', fontSize: 11, fontWeight: 'bold' },
  selectedPrinter: {
    fontSize: 12, color: '#008c8c', fontWeight: '600', marginTop: 10,
  },
  hint: { fontSize: 11, color: '#888', marginTop: 7, lineHeight: 17 },
  section: { fontSize: 14, fontWeight: '700', color: '#333', marginTop: 16, marginBottom: 8 },
  input: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd',
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, marginBottom: 10, color: '#222',
  },
  textArea: { minHeight: 85, textAlignVertical: 'top' },
  optionsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  optionBtn: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd',
    borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14,
    marginRight: 8, marginBottom: 8, minWidth: 100,
  },
  optionBtnActive: { backgroundColor: '#008c8c', borderColor: '#008c8c' },
  optionText: { fontSize: 13, fontWeight: '600', color: '#333' },
  optionPrice: { fontSize: 11, color: '#888', marginTop: 3 },
  optionTextActive: { color: '#fff' },
  pickerField: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd',
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 15,
    marginBottom: 10, flexDirection: 'row', alignItems: 'center',
  },
  pickerIcon: { fontSize: 20, marginRight: 12 },
  pickerValue: { flex: 1, fontSize: 15, fontWeight: '600', color: '#333' },
  pickerAction: { fontSize: 10, fontWeight: '700', color: '#008c8c' },
  summary: {
    backgroundColor: '#fff', padding: 16, borderRadius: 10,
    marginTop: 8, marginBottom: 8, borderWidth: 1, borderColor: '#eee',
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7 },
  summaryLabel: { fontSize: 14, color: '#666' },
  summaryValue: { fontSize: 14, fontWeight: '600', color: '#333' },
  summaryTotal: { borderTopWidth: 1, borderTopColor: '#eee', marginTop: 6, paddingTop: 12 },
  summaryTotalLabel: { fontSize: 16, fontWeight: '700', color: '#333' },
  summaryTotalValue: { fontSize: 19, fontWeight: 'bold', color: '#008c8c' },
  submitBtn: {
    backgroundColor: '#008c8c', paddingVertical: 17,
    borderRadius: 10, alignItems: 'center', marginTop: 25,
  },
  submitBtnPressed: { backgroundColor: '#006e6e' },
  submitBtnDisabled: { opacity: 0.6 },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  loadingButton: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  retryBtn: {
    backgroundColor: '#008c8c', paddingHorizontal: 25,
    paddingVertical: 12, borderRadius: 8, marginTop: 20, marginBottom: 15,
  },
  retryText: { color: '#fff', fontWeight: 'bold' },
});