import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, FlatList, RefreshControl, KeyboardAvoidingView,
  Platform, Keyboard,
} from 'react-native';
import { authFetch } from '../services/api';

const STATUS_FILTERS = [
  { key: '', label: 'All' },
  { key: 'Pending', label: 'Pending' },
  { key: 'Picked', label: 'Picked' },
  { key: 'Delivered', label: 'Delivered' },
  { key: 'notified', label: 'Notified' },
];

export default function CourierListScreen({ navigation }) {
  const [couriers, setCouriers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceTimer = useRef(null);

  // ============================================================
  // HARDWARE BARCODE SCANNER
  // ------------------------------------------------------------
  // The Q2i scanner works in "keyboard emulation" mode: it
  // types characters into the focused input and ends with Enter.
  // We keep a hidden TextInput focused at all times to capture it.
  // ============================================================
  const hiddenInputRef = useRef(null);

  const armScanner = useCallback(() => {
    // Small delay so it runs after any animation / navigation settles
    setTimeout(() => {
      try {
        hiddenInputRef.current?.focus();
      } catch (_) {
        /* ignore */
      }
    }, 150);
  }, []);

  const handleScanSubmit = useCallback((event) => {
    const code = (event?.nativeEvent?.text || '').trim();
    if (!code) return;

    // Fill search box directly and skip debounce — filter immediately
    setSearch(code);
    setDebouncedSearch(code);

    // Clear the hidden input so the next scan starts fresh
    try {
      hiddenInputRef.current?.clear();
    } catch (_) {
      /* ignore */
    }

    // Re-arm for the next scan
    armScanner();
  }, [armScanner]);

  // Re-arm scanner whenever the screen gets focus
  useEffect(() => {
    const unsub = navigation.addListener('focus', armScanner);
    armScanner();
    return unsub;
  }, [navigation, armScanner]);

  // Debounce manual typing in the real search box
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 400);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [search]);

  // ============================================================
  // DATA LOADING
  // ============================================================

  const loadPage = useCallback(async (pageNum, replace = false) => {
    if (pageNum === 1) {
      if (replace) setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError('');

    try {
      const qs = new URLSearchParams({
        page: String(pageNum),
        limit: '20',
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      }).toString();

      const data = await authFetch(`list_couriers.php?${qs}`);

      if (replace || pageNum === 1) {
        setCouriers(data.couriers);
      } else {
        setCouriers((prev) => [...prev, ...data.couriers]);
      }
      setTotal(data.total);
      setHasMore(pageNum < data.total_pages);
      setPage(pageNum);
    } catch (e) {
      setError(e.message || 'Failed to load couriers');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    loadPage(1, true);
  }, [debouncedSearch, statusFilter, loadPage]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      if (!loading) loadPage(1, true);
    });
    return unsub;
  }, [navigation, loading, loadPage]);

  const onRefresh = async () => {
    setRefreshing(true);
    setHasMore(true);
    await loadPage(1, true);
  };

  const loadMore = () => {
    if (loadingMore || !hasMore || loading) return;
    loadPage(page + 1);
  };

  const handleClearSearch = () => {
    setSearch('');
    setDebouncedSearch('');
    armScanner();
  };

  // ============================================================
  // RENDER
  // ============================================================

  const renderItem = ({ item }) => (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => navigation.navigate('CourierDetail', { courierId: item.courier_id })}
    >
      <View style={styles.cardRow}>
        <Text style={styles.tracking}>#{item.tracking}</Text>
        <StatusBadge status={item.status} />
      </View>
      <Text style={styles.detail}>
        From: <Text style={styles.detailBold}>{item.sender_name || '—'}</Text>
      </Text>
      <Text style={styles.detail}>
        To: <Text style={styles.detailBold}>{item.recipient_name || '—'}</Text>
      </Text>
      <View style={styles.cardRow}>
        <Text style={styles.amount}>{(item.amount || 0).toLocaleString()} RWF</Text>
        <Text style={styles.date}>{formatDate(item.created_at)}</Text>
      </View>
      {item.created_by_name && (
        <Text style={styles.byline}>by {item.created_by_name}</Text>
      )}
    </Pressable>
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#f5f7fa' }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* ===== HIDDEN SCANNER INPUT ===== */}
      <TextInput
        ref={hiddenInputRef}
        style={styles.hiddenScannerInput}
        onSubmitEditing={handleScanSubmit}
        autoCorrect={false}
        autoCapitalize="none"
        showSoftInputOnFocus={false}
        blurOnSubmit={false}
        caretHidden
        contextMenuHidden
      />

      {/* ===== FIXED HEADER ===== */}
      <View style={styles.fixedHeader}>
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <Text style={styles.title}>Couriers</Text>
          <Text style={styles.count}>{total.toLocaleString()}</Text>
        </View>

        {/* Search + Scan button */}
        <View style={styles.searchWrap}>
          <View style={styles.searchBox}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.search}
              placeholder="Search tracking, sender, recipient..."
              placeholderTextColor="#999"
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onFocus={() => {
                // When user taps the real search box, stop arming the hidden one
                // (the scanner would type here, which is fine — they'll see it live)
              }}
              onBlur={armScanner}
            />
            {search.length > 0 && (
              <Pressable onPress={handleClearSearch} style={styles.clearBtn}>
                <Text style={styles.clearText}>✕</Text>
              </Pressable>
            )}
          </View>

          {/* Re-arm scanner button */}
          <Pressable
            style={styles.scanBtn}
            onPress={() => {
              Keyboard.dismiss();
              armScanner();
            }}
          >
            <Text style={styles.scanIcon}>⎯⎯▮▮</Text>
            <Text style={styles.scanLabel}>SCAN</Text>
          </Pressable>
        </View>

        {/* Status chips */}
        <View style={styles.chipsWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsContainer}
            keyboardShouldPersistTaps="handled"
          >
            {STATUS_FILTERS.map((f) => (
              <Pressable
                key={f.key || 'all'}
                style={[styles.chip, statusFilter === f.key && styles.chipActive]}
                onPress={() => setStatusFilter(f.key)}
              >
                <Text style={[styles.chipText, statusFilter === f.key && styles.chipTextActive]}>
                  {f.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>

      {/* ===== ERROR ===== */}
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={onRefresh}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ===== LIST ===== */}
      <View style={styles.listWrap}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#008c8c" />
            <Text style={styles.loadingText}>Loading couriers...</Text>
          </View>
        ) : couriers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyText}>No couriers found</Text>
            {search || statusFilter ? (
              <Pressable onPress={() => { setSearch(''); setStatusFilter(''); setDebouncedSearch(''); armScanner(); }}>
                <Text style={styles.retryText}>Clear filters</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <FlatList
            data={couriers}
            keyExtractor={(item) => String(item.courier_id)}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#008c8c']} />
            }
            onEndReached={loadMore}
            onEndReachedThreshold={0.3}
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.footerLoading}>
                  <ActivityIndicator color="#008c8c" />
                  <Text style={styles.footerText}>Loading more...</Text>
                </View>
              ) : !hasMore && couriers.length > 0 ? (
                <Text style={styles.endText}>— End of list —</Text>
              ) : null
            }
          />
        )}
      </View>
    </KeyboardAvoidingView>
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
  // ---------- HIDDEN SCANNER INPUT ----------
  hiddenScannerInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    top: -50,
    left: -50,
  },

  // ---------- FIXED HEADER ----------
  fixedHeader: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },

  // ---------- TITLE ROW ----------
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 44,
    paddingBottom: 10,
  },
  backBtn: { paddingRight: 12 },
  backText: { color: '#008c8c', fontSize: 15, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: 'bold', color: '#222', flex: 1 },
  count: { fontSize: 13, color: '#008c8c', fontWeight: '600' },

  // ---------- SEARCH + SCAN BUTTON ----------
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f2f5',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 42,
  },
  searchIcon: { fontSize: 13, marginRight: 8 },
  search: {
    flex: 1,
    fontSize: 14,
    color: '#222',
    paddingVertical: 0,
  },
  clearBtn: { padding: 4, marginLeft: 4 },
  clearText: { fontSize: 14, color: '#999', fontWeight: '600' },

  scanBtn: {
    backgroundColor: '#008c8c',
    borderRadius: 10,
    height: 42,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanIcon: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: -1 },
  scanLabel: { color: '#fff', fontSize: 9, fontWeight: '700', marginTop: 1 },

  // ---------- FILTER CHIPS ----------
  chipsWrap: { paddingBottom: 12 },
  chipsContainer: { paddingHorizontal: 16, gap: 8 },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f0f2f5',
    borderWidth: 1,
    borderColor: 'transparent',
    minHeight: 34,
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: '#008c8c',
    borderColor: '#008c8c',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    includeFontPadding: false,
  },
  chipTextActive: { color: '#fff' },

  // ---------- LIST ----------
  listWrap: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 40 },

  // ---------- CARDS ----------
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardPressed: { opacity: 0.7 },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  tracking: { fontSize: 14, fontWeight: '700', color: '#008c8c' },
  detail: { fontSize: 13, color: '#666', marginTop: 2 },
  detailBold: { color: '#333', fontWeight: '500' },
  amount: { fontSize: 13, color: '#27ae60', fontWeight: '600', marginTop: 4 },
  date: { fontSize: 12, color: '#999' },
  byline: { fontSize: 11, color: '#aaa', marginTop: 6, fontStyle: 'italic' },

  badge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '600' },

  // ---------- STATES ----------
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  loadingText: { marginTop: 12, color: '#666', fontSize: 14 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#999', marginBottom: 12 },

  footerLoading: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
    gap: 8,
  },
  footerText: { color: '#666', fontSize: 13 },
  endText: { textAlign: 'center', color: '#bbb', fontSize: 12, padding: 20 },

  errorBox: {
    backgroundColor: '#fde8e8',
    padding: 12,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 8,
  },
  errorText: { color: '#c0392b', fontSize: 13, marginBottom: 6 },
  retryText: { color: '#008c8c', fontWeight: '600', fontSize: 13 },
});