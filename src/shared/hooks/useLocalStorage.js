/**
 * Custom hook for localStorage management
 * Provides a clean interface for persisting UI state
 */

import { useState, useEffect } from 'react';

/**
 * useLocalStorage - Persist state in localStorage
 * @param {string} key - localStorage key
 * @param {any} initialValue - Default value if not in localStorage
 * @param {number} debounceMs - Debounce delay for saving (default: 500ms)
 * @returns {[any, Function]} - [value, setValue]
 */
export const useLocalStorage = (key, initialValue, debounceMs = 500) => {
  // Initialize state from localStorage or use initial value
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) {
        // Try to parse as JSON, fall back to raw value
        try {
          return JSON.parse(saved);
        } catch {
          return saved;
        }
      }
      return initialValue;
    } catch (error) {
      console.warn(`Error loading from localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  // Debounced save to localStorage
  useEffect(() => {
    const handler = setTimeout(() => {
      try {
        const valueToStore = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(key, valueToStore);
      } catch (error) {
        console.warn(`Error saving to localStorage key "${key}":`, error);
      }
    }, debounceMs);

    return () => clearTimeout(handler);
  }, [key, value, debounceMs]);

  return [value, setValue];
};

export default useLocalStorage;

