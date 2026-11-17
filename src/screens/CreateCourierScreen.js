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

import { authFetch } from '../services/api';

// ============================================================
// LAZY NATIVE MODULE LOADER
// ============================================================

let EscPosPrinterModule = null;

const getEscPos = async () => {
  if (EscPosPrinterModule) return EscPosPrinterModule;

  // eslint-disable-next-line global-require
  const mod = require('rn-escpos-printer');

  EscPosPrinterModule = mod.EscPosPrinter || mod.default || mod;

  if (!EscPosPrinterModule) {
    throw new Error('rn-escpos-printer did not export EscPosPrinter.');
  }

  return EscPosPrinterModule;
};

// ============================================================
// CONFIGURATION
// ============================================================

const API_FORM = 'courier_form_data.php';
const API_CREATE = 'create_courier.php';

const PRINTER_TIMEOUT = 20000;
const DISCOVERY_TIMEOUT = 8000;

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

const formatMoney = (value) =>
  Number(value || 0).toLocaleString('en-US');

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
        throw new Error(
          'Location permission is required for Bluetooth access.'
        );
      }
    }
  }

  return true;
};

// ============================================================
// PRINTER DISCOVERY
// ============================================================

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      )
    ),
  ]);

const discoverPrinters = async () => {
  await requestBluetoothPermissions();

  const EscPosPrinter = await getEscPos();

  await withTimeout(
    EscPosPrinter.initialize(),
    DISCOVERY_TIMEOUT,
    'Printer init'
  );

  const devices = await withTimeout(
    EscPosPrinter.getPrinters({ scanDurationMs: 4000 }),
    DISCOVERY_TIMEOUT,
    'Printer scan'
  );

  return Array.isArray(devices) ? devices : [];
};

// ============================================================
// RECEIPT BUILDER
// ============================================================

const buildReceiptText = (receipt) => {
  const line = '--------------------------------';

  const rows = [
    '',
    '          FLASH COURIER',
    '       Fast - Secure - Reliable',
    line,
    `COURIER CODE: ${receipt.courierCode}`,
    `TRACKING: ${receipt.tracking}`,
    line,
    `SEND DATE: ${receipt.sendDate}`,
    `SEND TIME: ${receipt.sentTime}`,
    `CREATED: ${receipt.createdAt}`,
    line,
    'SENDER INFORMATION',
    `Name: ${receipt.senderName}`,
    `Phone: ${receipt.senderPhone}`,
    `From: ${receipt.fromLocation}`,
    line,
    'RECIPIENT INFORMATION',
    `Name: ${receipt.recipientName}`,
    `Phone: ${receipt.recipientPhone}`,
    `Destination: ${receipt.destination}`,
    line,
    'COURIER DETAILS',
    `Type: ${receipt.typeName}`,
    `Unit price: ${receipt.price} RWF`,
    `Quantity: ${receipt.quantity}`,
    `Served by: ${receipt.fullname || '-'}`,
    `Note: ${receipt.note || '-'}`,
    line,
    `TOTAL: ${receipt.amount} RWF`,
    line,
    'TRACK YOUR COURIER',
    'https://flashcourier.co.rw/reactflash/',
    `scan_invoice.php?invoice=${receipt.id}`,
    line,
    'Thank you for choosing',
    '        FLASH COURIER!',
    '',
    '',
  ];

  return rows.join('\n');
};

// ============================================================
// PRINT RECEIPT
// ============================================================

const printReceipt = async (receipt, printer) => {
  let connected = false;

  try {
    if (!printer) throw new Error('Please select a printer first.');

    await requestBluetoothPermissions();

    const EscPosPrinter = await getEscPos();

    await withTimeout(
      EscPosPrinter.initialize(),
      DISCOVERY_TIMEOUT,
      'Printer init'
    );

    await withTimeout(
      EscPosPrinter.connect(printer, { timeoutMs: PRINTER_TIMEOUT }),
      PRINTER_TIMEOUT + 2000,
      'Printer connect'
    );

    connected = true;

    const isConnected = await EscPosPrinter.isConnected();
    if (!isConnected) {
      throw new Error('Printer connection could not be established.');
    }

    const receiptText = buildReceiptText(receipt);

    await withTimeout(
      EscPosPrinter.printText(receiptText, {
        codePage: 'cp850',
        feedLines: 4,
        cut: true,
      }),
      PRINTER_TIMEOUT,
      'Print'
    );

    return { success: true, error: null };
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Unknown printing error.',
    };
  } finally {
    if (connected) {
      try {
        const EscPosPrinter = await getEscPos();
        await EscPosPrinter.disconnect();
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

  const candidates = [
    body.courier,
    body.data?.courier,
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
    throw new Error(
      body.error || body.message || 'Server rejected courier creation.'
    );
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

  // ----------------------------------------------------------
  // SAFE SETTERS
  // ----------------------------------------------------------

  const safeSet = useCallback((setter, value) => {
    if (mountedRef.current) setter(value);
  }, []);

  // ----------------------------------------------------------
  // DATE PICKER
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // TIME PICKER
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // PRINTER DISCOVERY
  // ----------------------------------------------------------

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
          'No paired Bluetooth printers were found.\n\n' +
            'Open Android Bluetooth settings and pair the Q2i printer, then try again.',
          [{ text: 'OK' }],
          { cancelable: false }
        );
        return;
      }

      Alert.alert(
        'Printer Discovery',
        `${devices.length} paired Bluetooth device(s) found. Select your printer below.`,
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

  // ----------------------------------------------------------
  // LOAD FORM DATA
  // ----------------------------------------------------------

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

      // sendingTime intentionally left empty — user must pick via clock
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

  // ----------------------------------------------------------
  // PRICE CALCULATION
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // RESET FORM
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // VALIDATE FORM
  // ----------------------------------------------------------

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
      return fail(
        'Missing Sending Time',
        'Please tap the clock field and select the sending time.'
      );
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

  // ----------------------------------------------------------
  // BUILD RECEIPT
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // SUBMIT
  // ----------------------------------------------------------

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
            `Courier: ${code}\n\nReceipt printed successfully.`,
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

  // ----------------------------------------------------------
  // MEMOIZED PRINTER OPTIONS
  // ----------------------------------------------------------

  const printerOptions = useMemo(() => {
    return printers.map((p) => ({
      ...p,
      active: selectedPrinter?.id === p.id,
    }));
  }, [printers, selectedPrinter]);

  // ----------------------------------------------------------
  // LOADING
  // ----------------------------------------------------------

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#008c8c" />
        <Text style={styles.loadingText}>Loading courier information...</Text>
      </View>
    );
  }

  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // MAIN
  // ----------------------------------------------------------

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
                    key={printer.id}
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
                        {printer.name || 'Unknown printer'}
                      </Text>
                      <Text
                        style={[
                          styles.printerAddress,
                          printer.active && styles.optionTextActive,
                        ]}
                      >
                        {printer.address}
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
              Pair the Q2i printer in Android Bluetooth settings before searching.
              Select the printer from the list.
            </Text>
            <Text style={styles.selectedPrinter}>
              Selected: {selectedPrinter?.name || 'No printer selected'}
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

        {/* Schedule shortcuts removed — sending time is picked only via clock */}

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