import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { authFetch } from '../services/api';

export default function CreateCourierScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState(null);

  // Form state
  const [senderName, setSenderName] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [typeId, setTypeId] = useState(null);
  const [quantity, setQuantity] = useState('1');
  const [receivingAt, setReceivingAt] = useState('');
  const [partnerId, setPartnerId] = useState(null);
  const [sendDate, setSendDate] = useState(new Date().toISOString().slice(0, 10));
  const [sendingTime, setSendingTime] = useState('');
  const [note, setNote] = useState('');

  // Derived
  const [price, setPrice] = useState('0');
  const [amount, setAmount] = useState('0');

  // Load dropdown data
  useEffect(() => {
    (async () => {
      try {
        const data = await authFetch('courier_form_data.php');
        setFormData(data);
        // Set defaults
        if (data.types?.length) setTypeId(data.types[0].id);
        if (data.partners?.length) setPartnerId(data.partners[0].id);
        if (data.schedules?.length) setSendingTime(data.schedules[0].time);
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to load form data');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Update price/amount when type or quantity changes
  useEffect(() => {
    if (!formData || !typeId) return;
    const selectedType = formData.types.find((t) => t.id === typeId);
    if (selectedType) {
      const qty = parseFloat(quantity) || 1;
      const total = selectedType.base_price * qty;
      setPrice(selectedType.base_price.toFixed(0));
      setAmount(total.toFixed(0));
    }
  }, [typeId, quantity, formData]);

  const handleSubmit = async () => {
    // Validation
    if (!senderName.trim() || !senderPhone.trim() || !recipientName.trim() || !recipientPhone.trim()) {
      Alert.alert('Missing fields', 'Please fill sender and recipient details');
      return;
    }
    if (!receivingAt.trim()) {
      Alert.alert('Missing destination', 'Please enter destination address');
      return;
    }

    setSubmitting(true);
    try {
      const data = await authFetch('create_courier.php', {
        method: 'POST',
        body: JSON.stringify({
          sending_from: formData?.default_location?.id || null,
          sender_name: senderName.trim(),
          sender_phone: senderPhone.trim(),
          recipient_name: recipientName.trim(),
          recipient_phone: recipientPhone.trim(),
          type_id: typeId,
          price: price,
          quantity: quantity,
          amount: amount,
          receiving_at: receivingAt.trim(),
          partner_id: partnerId,
          send_date: sendDate,
          sending_time: sendingTime,
          note: note.trim(),
        }),
      });

      Alert.alert(
        '✅ Success',
        `Courier created!\nTracking: ${data.courier.tracking}`,
        [
          {
            text: 'OK',
            onPress: () => navigation.replace('Dashboard'),
          },
        ]
      );
    } catch (e) {
      Alert.alert('Failed to create courier', e.message || 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#008c8c" />
        <Text style={styles.loadingText}>Loading form data...</Text>
      </View>
    );
  }

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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>New Courier</Text>
      </View>

      {/* Sender */}
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

      {/* Recipient */}
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

      {/* Destination */}
      <Text style={styles.section}>Destination</Text>
      <TextInput
        style={styles.input}
        placeholder="Destination address (e.g., MUSANZE) *"
        placeholderTextColor="#999"
        value={receivingAt}
        onChangeText={setReceivingAt}
      />

      {/* Courier type */}
      <Text style={styles.section}>Courier Type</Text>
      <View style={styles.optionsGrid}>
        {formData.types.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.optionBtn, typeId === t.id && styles.optionBtnActive]}
            onPress={() => setTypeId(t.id)}
          >
            <Text style={[styles.optionText, typeId === t.id && styles.optionTextActive]}>
              {t.type_name}
            </Text>
            <Text style={[styles.optionPrice, typeId === t.id && styles.optionTextActive]}>
              {t.base_price.toLocaleString()} RWF
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Quantity */}
      <Text style={styles.section}>Quantity</Text>
      <TextInput
        style={styles.input}
        placeholder="1"
        placeholderTextColor="#999"
        keyboardType="number-pad"
        value={quantity}
        onChangeText={setQuantity}
      />

      {/* Price summary */}
      <View style={styles.summary}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Unit price</Text>
          <Text style={styles.summaryValue}>{parseFloat(price).toLocaleString()} RWF</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Quantity</Text>
          <Text style={styles.summaryValue}>{quantity}</Text>
        </View>
        <View style={[styles.summaryRow, styles.summaryTotal]}>
          <Text style={styles.summaryTotalLabel}>Total</Text>
          <Text style={styles.summaryTotalValue}>{parseFloat(amount).toLocaleString()} RWF</Text>
        </View>
      </View>

      {/* Partner */}
      <Text style={styles.section}>Carrier Partner</Text>
      <View style={styles.optionsGrid}>
        {formData.partners.map((p) => (
          <Pressable
            key={p.id}
            style={[styles.optionBtn, partnerId === p.id && styles.optionBtnActive]}
            onPress={() => setPartnerId(p.id)}
          >
            <Text style={[styles.optionText, partnerId === p.id && styles.optionTextActive]}>
              {p.partner_name}
            </Text>
            <Text style={[styles.optionPrice, partnerId === p.id && styles.optionTextActive]}>
              {p.transport_type}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Send date */}
      <Text style={styles.section}>Send Date</Text>
      <TextInput
        style={styles.input}
        placeholder="YYYY-MM-DD"
        placeholderTextColor="#999"
        value={sendDate}
        onChangeText={setSendDate}
      />

      {/* Sending time */}
      <Text style={styles.section}>Sending Time</Text>
      <View style={styles.optionsGrid}>
        {formData.schedules.map((s) => (
          <Pressable
            key={s.id}
            style={[styles.optionBtn, sendingTime === s.time && styles.optionBtnActive]}
            onPress={() => setSendingTime(s.time)}
          >
            <Text style={[styles.optionText, sendingTime === s.time && styles.optionTextActive]}>
              {s.time}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Note */}
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

      {/* Submit */}
      <Pressable
        style={({ pressed }) => [styles.submitBtn, pressed && styles.submitBtnPressed, submitting && styles.submitBtnDisabled]}
        onPress={handleSubmit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Create Courier</Text>
        )}
      </Pressable>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 20, paddingTop: 40, paddingBottom: 60 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f7fa' },
  loadingText: { marginTop: 12, color: '#666' },
  errorText: { color: '#c0392b', fontSize: 16 },

  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  backBtn: { color: '#008c8c', fontSize: 15, fontWeight: '600', marginRight: 16 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#222' },

  section: { fontSize: 14, fontWeight: '600', color: '#333', marginTop: 16, marginBottom: 8 },

  input: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd',
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, marginBottom: 10, color: '#222',
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },

  optionsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  optionBtn: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd',
    borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14,
    marginRight: 8, marginBottom: 8, minWidth: 100,
  },
  optionBtnActive: { backgroundColor: '#008c8c', borderColor: '#008c8c' },
  optionText: { fontSize: 13, fontWeight: '600', color: '#333' },
  optionPrice: { fontSize: 11, color: '#888', marginTop: 2 },
  optionTextActive: { color: '#fff' },

  summary: { backgroundColor: '#fff', padding: 16, borderRadius: 10, marginTop: 8, marginBottom: 8 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  summaryLabel: { fontSize: 14, color: '#666' },
  summaryValue: { fontSize: 14, fontWeight: '600', color: '#333' },
  summaryTotal: { borderTopWidth: 1, borderTopColor: '#eee', marginTop: 6, paddingTop: 10 },
  summaryTotalLabel: { fontSize: 16, fontWeight: '700', color: '#333' },
  summaryTotalValue: { fontSize: 18, fontWeight: 'bold', color: '#008c8c' },

  submitBtn: {
    backgroundColor: '#008c8c', paddingVertical: 16, borderRadius: 10,
    alignItems: 'center', marginTop: 24,
  },
  submitBtnPressed: { backgroundColor: '#006e6e' },
  submitBtnDisabled: { opacity: 0.6 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});