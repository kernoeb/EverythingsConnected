import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

// We create the app instance
const app = createApp(App)

// Mount to the div with id="app" defined in index.html
app.mount('#app')
