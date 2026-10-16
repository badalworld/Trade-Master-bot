import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCryptoPrice(price: number): string {
  if (isNaN(price) || price === 0) return '0.00';
  if (price < 0.0001) {
    return price.toFixed(8);
  }
  if (price < 0.01) {
    return price.toFixed(6);
  }
  if (price < 1) {
    return price.toFixed(4);
  }
  if (price < 10) {
    return price.toFixed(3);
  }
  return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let globalIdCounter = 0;
export function generateUniqueId(prefix: string = 'id'): string {
  globalIdCounter += 1;
  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 9);
  return `${prefix}-${timestamp}-${globalIdCounter}-${rand}`;
}
