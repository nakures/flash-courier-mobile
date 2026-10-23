import AsyncStorage from '@react-native-async-storage/async-storage';

// ⚠️ Change this if your API URL changes
const API_BASE_URL = 'https://flashcourier.co.rw/reactflash/api';

/**
 * Authenticated fetch — auto-attaches Bearer token.
 * Falls back to query-string token for hosts that strip headers
 * (common on cPanel / CGI / FastCGI servers).
 */
export async function authFetch(endpoint, options = {}) {
  const token = await AsyncStorage.getItem('token');
  if (!token) {
    throw new Error('No token found. Please login.');
  }

  // Append token to URL — works on ALL hosting configs
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${API_BASE_URL}/${endpoint}${sep}token=${encodeURIComponent(token)}`;

  // Debug: uncomment to see the full URL in Metro terminal
  // console.log('[authFetch]', url);

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // Send both headers too — harmless if stripped, useful if allowed
      'Authorization': `Bearer ${token}`,
      'X-Auth-Token': token,
      ...(options.headers || {}),
    },
  });

  const data = await response.json();

  if (!response.ok || data.success === false) {
    throw new Error(data.message || `Request failed (${response.status})`);
  }

  return data;
}

/**
 * Unauthenticated fetch — for login, register, password reset, etc.
 */
export async function publicFetch(endpoint, options = {}) {
  const url = `${API_BASE_URL}/${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await response.json();
  return data;
}

/**
 * Save auth data after successful login.
 */
export async function saveAuth(token, user) {
  await AsyncStorage.setItem('token', token);
  await AsyncStorage.setItem('user', JSON.stringify(user));
}

/**
 * Clear auth data (logout).
 */
export async function clearAuth() {
  await AsyncStorage.removeItem('token');
  await AsyncStorage.removeItem('user');
}

/**
 * Check if user is logged in.
 */
export async function isLoggedIn() {
  const token = await AsyncStorage.getItem('token');
  return !!token;
}

/**
 * Get stored user object (from login).
 */
export async function getStoredUser() {
  const user = await AsyncStorage.getItem('user');
  return user ? JSON.parse(user) : null;
}

/**
 * Get just the stored token string.
 */
export async function getToken() {
  return await AsyncStorage.getItem('token');
}