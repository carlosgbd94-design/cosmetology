import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Urbanist', 'sans-serif'],
        sora: ['Sora', 'sans-serif'],
      },
      transitionProperty: {
        'all-custom': 'all',
      },
      transitionTimingFunction: {
        'custom-bezier': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      transitionDuration: {
        '400': '400ms',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        toastIn: {
          '0%': { opacity: '0', transform: 'translateX(16px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateX(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.18s ease-out both',
        'toast-in': 'toastIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      colors: {
        luxe: {
          50: '#FAF9F6',
          100: '#F2F0EA',
          200: '#E5E0D5',
          300: '#CCCCCC',
          400: '#999999',
          500: '#666666',
          600: '#444444',
          700: '#222225',
          800: '#1A1A1E',
          900: '#121215',
          950: '#0A0A0D',
        },
        bronze: {
          50: '#FCF9F2',
          100: '#F7EEDB',
          500: '#D4AF37',
          600: '#B5902B',
          700: '#8C6E20',
        }
      }
    },
  },
  plugins: [
    // Variante "touch:" análoga a "dark:" (mismo mecanismo que darkMode: 'class'): en vez de basarse
    // en el ancho de pantalla (que ya cubren sm:/md:/lg:), se activa cuando App.tsx pone la clase
    // "touch-device" en el contenedor raíz según isTouchPrimaryDevice(). Así cualquier elemento puede
    // llevar ajustes específicos para dedo/lápiz (touch:grid-cols-1, touch:py-3, etc.) sin repetir
    // ternarios de JS en cada sitio.
    plugin(function ({ addVariant }) {
      addVariant('touch', '.touch-device &');
    }),
  ],
}
