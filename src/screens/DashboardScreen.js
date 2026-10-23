import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { authFetch, clearAuth, getStoredUser } from '../services/api';

export default function DashboardScreen({ navigation }) {
  const [user, setUser] = useState(null);
  const [stats, setStats] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setError('');
    try {
      const data = await authFetch('dashboard.php');
      setUser(data.user);
      setStats(data.stats);
      setIsAdmin(!!data.is_admin);
      setRecent(data.recent || []);
    } catch (e) {
      if (e.message && (e.message.includes('Token') || e.message.includes('401'))) {
        await clearAuth();
        navigation.replace('Login');
        return;
      }
      setError(e.message || 'Cannot load dashboard');
    }
  }, [navigation]);

  useEffect(() => {
    (async () => {
      const stored = await getStoredUser();
      if (stored) setUser(stored);
      await loadData();
      setLoading(false);
    })();
  }, [loadData]);

  // Reload when returning from CreateCourier / CourierList
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      if (!loading) loadData();
    });
    return unsubscribe;
  }, [navigation, loading, loadData]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          await clearAuth();
          navigation.replace('Login');
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#008c8c" />
        <Text style={styles.loadingText}>Loading dashboard...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#008c8c']} />
      }
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>Welcome back,</Text>
          <Text style={styles.name}>{user?.fullname || user?.username || 'User'}</Text>
          <Text style={styles.role}>
            {isAdmin ? '👑 Admin' : '👤 User'}
            {user?.location ? ` · ${user.location}` : ''}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            style={({ pressed }) => [styles.newBtn, pressed && styles.newBtnPressed]}
            onPress={() => navigation.navigate('CreateCourier')}
          >
            <Text style={styles.newBtnText}>+ New</Text>
          </Pressable>
          <Pressable style={styles.logoutBtn} onPress={handleLogout}>
            <Text style={styles.logoutText}>Logout</Text>
          </Pressable>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={onRefresh}>
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>
        {isAdmin ? 'Global Overview' : 'My Overview'}
      </Text>

      <View style={styles.statsGrid}>
        <StatCard
          label={isAdmin ? 'All Couriers' : 'My Couriers'}
          value={stats?.all_couriers ?? 0}
          color="#008c8c"
          icon="📦"
        />
        <StatCard
          label="Today"
          value={stats?.today_couriers ?? 0}
          color="#6C63FF"
          icon="📅"
        />
        <StatCard
          label={isAdmin ? 'All Delivered' : 'My Delivered'}
          value={stats?.all_delivered ?? 0}
          color="#27ae60"
          icon="✅"
        />
        <StatCard
          label={isAdmin ? 'All Picked' : 'My Picked'}
          value={stats?.all_picked ?? 0}
          color="#3498db"
          icon="📬"
        />
      </View>

      <View style={styles.moneyGrid}>
        <MoneyCard
          label="Balance"
          value={stats?.balance ?? 0}
          color="#27ae60"
        />
        <MoneyCard
          label="Today's Expense"
          value={stats?.today_expense ?? 0}
          color="#c0392b"
        />
      </View>

      {stats?.today_revenue > 0 && (
        <View style={styles.revenueCard}>
          <Text style={styles.revenueLabel}>Today's Revenue</Text>
          <Text style={styles.revenueValue}>
            +{(stats?.today_revenue ?? 0).toLocaleString()} RWF
          </Text>
        </View>
      )}

      {/* ====== Recent Couriers section with View All link ====== */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitleNoMargin}>
          {isAdmin ? 'Recent Couriers (All)' : 'Recent Couriers (Mine)'}
        </Text>
        <Pressable onPress={() => navigation.navigate('CourierList')}>
          <Text style={styles.viewAll}>View All →</Text>
        </Pressable>
      </View>

      {recent.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>No couriers yet</Text>
        </View>
      ) : (
        recent.map((c) => (
          <Pressable
            key={c.courier_id}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            onPress={() => navigation.navigate('CourierList')}
          >
            <View style={styles.cardRow}>
              <Text style={styles.tracking}>{c.tracking}</Text>
              <StatusBadge status={c.status} />
            </View>
            <Text style={styles.detail}>
              From: <Text style={styles.detailBold}>{c.sender_name || '—'}</Text>
            </Text>
            <Text style={styles.detail}>
              To: <Text style={styles.detailBold}>{c.recipient_name || '—'}</Text>
            </Text>
            <View style={styles.cardRow}>
              <Text style={styles.amount}>{(c.amount || 0).toLocaleString()} RWF</Text>
              <Text style={styles.date}>{formatDate(c.created_at)}</Text>
            </View>
          </Pressable>
        ))
      )}

      <Text style={styles.footer}>Pull down to refresh · Flash Courier</Text>
    </ScrollView>
  );
}

function StatCard({ label, value, color, icon }) {
  return (
    <View style={[styles.statCard, { borderLeftColor: color }]}>
      <Text style={styles.statIcon}>{icon}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function MoneyCard({ label, value, color }) {
  return (
    <View style={[styles.moneyCard, { borderLeftColor: color }]}>
      <Text style={styles.moneyLabel}>{label}</Text>
      <Text style={[styles.moneyValue, { color }]}>
        {Number(value || 0).toLocaleString()} RWF
      </Text>
    </View>
  );
}

function StatusBadge({ status }) {
  const colors = {
    Pending: { bg: '#fef5e7', text: '#b9770e' },
    Picked: { bg: '#eaf2f8', text: '#2874a6' },
    Delivered: { bg: '#eafaf1', text: '#1e8449' },
    notified: { bg: '#f4ecf7', text: '#7d3c98' },
  };
  const c = colors[status] || { bg: '#eee', text: '#555' };
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.text }]}>{status}</Text>
    </View>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fa' },
  content: { padding: 20, paddingTop: 40, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f7fa' },
  loadingText: { marginTop: 12, color: '#666', fontSize: 14 },

  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  greeting: { fontSize: 14, color: '#888' },
  name: { fontSize: 22, fontWeight: 'bold', color: '#222', marginTop: 2 },
  role: { fontSize: 13, color: '#008c8c', marginTop: 4 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },

  newBtn: {
    backgroundColor: '#008c8c',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    marginRight: 6,
  },
  newBtnPressed: { backgroundColor: '#006e6e' },
  newBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  logoutBtn: {
    backgroundColor: '#fff', paddingVertical: 8, paddingHorizontal: 14,
    borderRadius: 8, borderWidth: 1, borderColor: '#c0392b',
  },
  logoutText: { color: '#c0392b', fontSize: 13, fontWeight: '600' },

  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#333', marginBottom: 12, marginTop: 8 },
  sectionTitleNoMargin: { fontSize: 16, fontWeight: '600', color: '#333' },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  viewAll: { color: '#008c8c', fontSize: 13, fontWeight: '600' },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 8 },
  statCard: {
    width: '48%', backgroundColor: '#fff', borderRadius: 10, padding: 16, marginBottom: 12,
    borderLeftWidth: 4,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  statIcon: { fontSize: 20, marginBottom: 4 },
  statValue: { fontSize: 26, fontWeight: 'bold', color: '#222' },
  statLabel: { fontSize: 12, color: '#888', marginTop: 4 },

  moneyGrid: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  moneyCard: {
    width: '48%', backgroundColor: '#fff', borderRadius: 10, padding: 14,
    borderLeftWidth: 4,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  moneyLabel: { fontSize: 12, color: '#888', marginBottom: 6 },
  moneyValue: { fontSize: 18, fontWeight: 'bold' },

  revenueCard: {
    backgroundColor: '#eafaf1', borderRadius: 10, padding: 14,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 12,
  },
  revenueLabel: { fontSize: 13, color: '#1e8449' },
  revenueValue: { fontSize: 16, fontWeight: 'bold', color: '#27ae60' },

  card: {
    backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 10,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  cardPressed: { opacity: 0.7 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  tracking: { fontSize: 14, fontWeight: '700', color: '#008c8c' },
  detail: { fontSize: 13, color: '#666', marginTop: 2 },
  detailBold: { color: '#333', fontWeight: '500' },
  amount: { fontSize: 13, color: '#27ae60', fontWeight: '600', marginTop: 4 },
  date: { fontSize: 12, color: '#999' },

  badge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '600' },

  emptyBox: { backgroundColor: '#fff', padding: 20, borderRadius: 10, alignItems: 'center' },
  emptyText: { color: '#999', fontSize: 14 },

  errorBox: { backgroundColor: '#fde8e8', padding: 12, borderRadius: 8, marginBottom: 16 },
  errorText: { color: '#c0392b', fontSize: 13, marginBottom: 6 },
  retryText: { color: '#008c8c', fontWeight: '600', fontSize: 13 },

  footer: { textAlign: 'center', color: '#bbb', fontSize: 12, marginTop: 24 },
});