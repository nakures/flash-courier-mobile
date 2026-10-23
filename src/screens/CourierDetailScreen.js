import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, Switch,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { authFetch } from '../services/api';

export default function CourierDetailScreen({ route, navigation }) {
  const { courierId } = route.params;

  const [courier, setCourier] = useState(null);
  const [pickup, setPickup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [skipSms, setSkipSms] = useState(false);

  const loadData = useCallback(async () => {
    setError('');
    try {
      const data = await authFetch(`courier_detail.php?courier_id=${courierId}`);
      setCourier(data.courier);
      setPickup(data.pickup);
    } catch (e) {
      setError(e.message || 'Failed to load courier');
    }
  }, [courierId]);

  useEffect(() => {
    (async () => {
      await loadData();
      setLoading(false);
    })();
  }, [loadData]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleAcknowledge = () => {
    const msg = skipSms
      ? 'Confirm arrival? SMS will NOT be sent (recipient is present).'
      : 'Confirm arrival? SMS will be sent to recipient.';
    Alert.alert('Acknowledge Arrival', msg, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        onPress: async () => {
          setActing(true);
          try {
            const res = await authFetch('acknowledge_arrival.php', {
              method: 'POST',
              body: JSON.stringify({ courier_id: courierId, skip_sms: skipSms }),
            });
            let msgText = res.message || 'Arrival acknowledged';
            if (res.sms?.status === 'sent') msgText += '\n✅ SMS sent to recipient';
            else if (res.sms?.status === 'failed') msgText += '\n⚠️ SMS failed';
            else if (res.sms?.status === 'skipped') msgText += '\n(SMS skipped)';
            Alert.alert('Success', msgText);
            await loadData();
          } catch (e) {
            Alert.alert('Failed', e.message || 'Could not acknowledge');
          } finally {
            setActing(false);
          }
        },
      },
    ]);
  };

  const handleConfirmPickup = () => {
    Alert.alert(
      'Confirm Pickup',
      'Recipient received the courier? SMS will be sent to sender.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            setActing(true);
            try {
              const res = await authFetch('confirm_pickup.php', {
                method: 'POST',
                body: JSON.stringify({ courier_id: courierId }),
              });
              let msgText = 'Pickup confirmed';
              if (res.sms?.status === 'sent') msgText += '\n✅ SMS sent to sender';
              else if (res.sms?.status === 'failed') msgText += '\n⚠️ SMS failed';
              Alert.alert('Success', msgText);
              await loadData();
            } catch (e) {
              Alert.alert('Failed', e.message || 'Could not confirm pickup');
            } finally {
              setActing(false);
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#008c8c" />
      </View>
    );
  }

  if (!courier) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error || 'Courier not found'}</Text>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.backLink}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const isPicked = !!pickup;
  const isArrived = !!courier.arrived_at;
  const isPending = !isArrived && !isPicked;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#008c8c']} />
      }
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Courier #{courier.tracking}</Text>
        <StatusBadge status={courier.status} />
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* Summary card */}
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <Text style={styles.label}>Type</Text>
          <Text style={styles.value}>{courier.type_name || '—'}</Text>
        </View>
        <View style={styles.cardRow}>
          <Text style={styles.label}>Amount</Text>
          <Text style={styles.amountValue}>{(courier.amount || 0).toLocaleString()} RWF</Text>
        </View>
        <View style={styles.cardRow}>
          <Text style={styles.label}>Quantity</Text>
          <Text style={styles.value}>{courier.quantity}</Text>
        </View>
        <View style={styles.cardRow}>
          <Text style={styles.label}>Created</Text>
          <Text style={styles.value}>{formatDateTime(courier.created_at)}</Text>
        </View>
      </View>

      {/* Sender */}
      <Text style={styles.sectionTitle}>Sender</Text>
      <View style={styles.card}>
        <Text style={styles.bigName}>{courier.sender_name}</Text>
        <Text style={styles.phone}>{courier.sender_phone}</Text>
        <Text style={styles.small}>From: {courier.location_name || '—'}</Text>
      </View>

      {/* Recipient */}
      <Text style={styles.sectionTitle}>Recipient</Text>
      <View style={styles.card}>
        <Text style={styles.bigName}>{courier.recipient_name}</Text>
        <Text style={styles.phone}>{courier.recipient_phone}</Text>
        <Text style={styles.small}>To: {courier.receiving_at || '—'}</Text>
      </View>

      {/* Note */}
      {courier.note ? (
        <>
          <Text style={styles.sectionTitle}>Note</Text>
          <View style={styles.card}>
            <Text style={styles.value}>{courier.note}</Text>
          </View>
        </>
      ) : null}

      {/* Timeline */}
      <Text style={styles.sectionTitle}>Timeline</Text>
      <View style={styles.card}>
        <TimelineItem
          color="#888"
          label="Created"
          time={courier.created_at}
          note={courier.created_by_name ? `by ${courier.created_by_name}` : null}
        />
        {isArrived && (
          <TimelineItem
            color="#3498db"
            label="Arrived (notified)"
            time={courier.arrived_at}
            note="Recipient notified to pick up"
          />
        )}
        {isPicked && (
          <TimelineItem
            color="#27ae60"
            label="Picked Up"
            time={pickup.picked_up_at}
            note="Sender notified — delivery complete"
            last
          />
        )}
        {!isArrived && (
          <TimelineItem
            color="#f39c12"
            label="Awaiting arrival"
            time={null}
            note="Mark as arrived when courier reaches destination"
            last
          />
        )}
      </View>

      {/* Actions */}
      {isPending && (
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>Step 1 — Acknowledge Arrival</Text>
          <Text style={styles.actionDesc}>
            Mark this courier as arrived at the destination office.
            An SMS will be sent to the recipient to come pick it up.
          </Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Recipient is here — skip SMS</Text>
            <Switch
              value={skipSms}
              onValueChange={setSkipSms}
              trackColor={{ true: '#008c8c', false: '#ccc' }}
            />
          </View>
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed, acting && styles.btnDisabled]}
            onPress={handleAcknowledge}
            disabled={acting}
          >
            {acting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Acknowledge Arrival</Text>}
          </Pressable>
        </View>
      )}

      {isArrived && !isPicked && (
        <View style={styles.actionCard}>
          <Text style={styles.actionTitle}>Step 2 — Confirm Pickup</Text>
          <Text style={styles.actionDesc}>
            Confirm that the recipient has picked up the courier.
            An SMS will be sent to the sender to confirm delivery.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.successBtn, pressed && styles.primaryBtnPressed, acting && styles.btnDisabled]}
            onPress={handleConfirmPickup}
            disabled={acting}
          >
            {acting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Confirm Picked Up & Notify Sender</Text>}
          </Pressable>
        </View>
      )}

      {isPicked && (
        <View style={styles.completedCard}>
          <Text style={styles.completedTitle}>✅ Delivery Completed</Text>
          <Text style={styles.completedText}>
            Picked up on {formatDateTime(pickup.picked_up_at)}. Sender has been notified.
          </Text>
        </View>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function TimelineItem({ color, label, time, note, last }) {
  return (
    <View style={styles.timelineRow}>
      <View style={styles.timelineLeft}>
        <View style={[styles.timelineDot, { backgroundColor: color }]} />
        {!last && <View style={styles.timelineLine} />}
      </View>
      <View style={styles.timelineContent}>
        <Text style={[styles.timelineLabel, { color }]}>{label}</Text>
        {time ? <Text style={styles.timelineTime}>{formatDateTime(time)}</Text> : null}
        {note ? <Text style={styles.timelineNote}>{note}</Text> : null}
      </View>
    </View>
  );
}

function StatusBadge({ status }) {
  const colors = {
    Pending: { bg: '#fef5e7', text: '#b9770e' },
    Picked: { bg: '#eafaf1', text: '#1e8449' },
    Delivered: { bg: '#eafaf1', text: '#1e8449' },
    notified: { bg: '#eaf2f8', text: '#2874a6' },
  };
  const c = colors[status] || { bg: '#eee', text: '#555' };
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.text }]}>{status}</Text>
    </View>
  );
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 16, paddingTop: 44, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: '#f5f7fa' },

  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  backText: { color: '#008c8c', fontSize: 15, fontWeight: '600', marginRight: 12 },
  title: { fontSize: 18, fontWeight: 'bold', color: '#222', flex: 1 },

  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#555', marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },

  card: { backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 8, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  label: { fontSize: 13, color: '#888' },
  value: { fontSize: 13, color: '#333', fontWeight: '500' },
  amountValue: { fontSize: 14, color: '#27ae60', fontWeight: 'bold' },

  bigName: { fontSize: 16, fontWeight: '600', color: '#222', marginBottom: 2 },
  phone: { fontSize: 14, color: '#666', marginBottom: 4 },
  small: { fontSize: 12, color: '#999' },

  timelineRow: { flexDirection: 'row', minHeight: 60 },
  timelineLeft: { width: 20, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
  timelineLine: { width: 2, flex: 1, backgroundColor: '#e0e0e0', marginTop: 4 },
  timelineContent: { flex: 1, paddingBottom: 16 },
  timelineLabel: { fontSize: 13, fontWeight: '700' },
  timelineTime: { fontSize: 12, color: '#666', marginTop: 2 },
  timelineNote: { fontSize: 11, color: '#999', marginTop: 2, fontStyle: 'italic' },

  actionCard: { backgroundColor: '#fff', borderRadius: 10, padding: 16, marginTop: 16, borderWidth: 1, borderColor: '#008c8c' },
  actionTitle: { fontSize: 15, fontWeight: '700', color: '#008c8c', marginBottom: 6 },
  actionDesc: { fontSize: 13, color: '#666', marginBottom: 12, lineHeight: 18 },

  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, marginBottom: 12 },
  switchLabel: { fontSize: 13, color: '#333', flex: 1, marginRight: 8 },

  primaryBtn: { backgroundColor: '#008c8c', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  primaryBtnPressed: { opacity: 0.85 },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  successBtn: { backgroundColor: '#27ae60', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  btnDisabled: { opacity: 0.5 },

  completedCard: { backgroundColor: '#eafaf1', borderRadius: 10, padding: 16, marginTop: 16, borderWidth: 1, borderColor: '#27ae60' },
  completedTitle: { fontSize: 16, fontWeight: '700', color: '#1e8449', marginBottom: 6 },
  completedText: { fontSize: 13, color: '#1e8449' },

  badge: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '700' },

  errorBox: { backgroundColor: '#fde8e8', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#c0392b', fontSize: 13 },
  backLink: { color: '#008c8c', fontSize: 14, marginTop: 16, fontWeight: '600' },
});