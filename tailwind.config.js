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
  plugins: [],
}
