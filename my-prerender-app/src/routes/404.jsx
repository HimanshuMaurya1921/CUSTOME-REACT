// src/routes/404.jsx
import React from 'react'
import './404.css'

export default function NotFound() {
  return (
    <div className="not-found-container">
      <h1>404</h1>
      <p>Page Not Found</p>
      <nav>
        <a href="/">Go to Home</a>
      </nav>
    </div>
  )
}
