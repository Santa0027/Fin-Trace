import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AuthProvider } from '../providers/AuthProvider'
import { TenantProvider } from '../providers/TenantProvider'
import '../styles/globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <TenantProvider>
        <App />
      </TenantProvider>
    </AuthProvider>
  </React.StrictMode>,
)
