import { useState, useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Lazy-loaded screens: only imported when navigated to
import LoginScreen from '../screens/LoginScreen';
import DashboardScreen from '../screens/DashboardScreen';
import CourierListScreen from '../screens/CourierListScreen';
import CourierDetailScreen from '../screens/CourierDetailScreen';

// CreateCourierScreen is intentionally NOT imported here.
// It will be loaded on demand to prevent its native imports
// from crashing the app on startup.
const LazyCreateCourierScreen = (props) => {
  const CreateCourierScreen = require('../screens/CreateCourierScreen').default;
  return <CreateCourierScreen {...props} />;
};

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  const [initialRoute, setInitialRoute] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await AsyncStorage.getItem('token');
        setInitialRoute(token ? 'Dashboard' : 'Login');
      } catch {
        setInitialRoute('Login');
      }
    })();
  }, []);

  if (!initialRoute) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#008c8c" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName={initialRoute} screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="Dashboard" component={DashboardScreen} />
        <Stack.Screen name="CreateCourier" component={LazyCreateCourierScreen} />
        <Stack.Screen name="CourierList" component={CourierListScreen} />
        <Stack.Screen name="CourierDetail" component={CourierDetailScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f7fa' },
});