import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

/**
 * Cross-platform key-value storage.
 * - Native: expo-secure-store (encrypted)
 * - Web: localStorage (plain text)
 */

const memoryFallback = new Map<string, string>()

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return localStorage.getItem(key)
    } catch {
      return memoryFallback.get(key) ?? null
    }
  }
  return SecureStore.getItemAsync(key)
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      localStorage.setItem(key, value)
    } catch {
      memoryFallback.set(key, value)
    }
    return
  }
  return SecureStore.setItemAsync(key, value)
}

async function removeItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      localStorage.removeItem(key)
    } catch {
      memoryFallback.delete(key)
    }
    return
  }
  return SecureStore.deleteItemAsync(key)
}

export const Storage = { getItem, setItem, removeItem }
