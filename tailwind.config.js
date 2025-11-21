/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./App.css",
    "./index.css", // This line is the important one
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}