// src/routes/index.jsx
import React from 'react'
import './index.css'

export default function Home() {
  return (
    <div>
      <h1>Welcome to Home Page</h1>
      <p>This page is pre-rendered and served as static HTML with zero JavaScript.</p>
      <nav>
        <a href="/contact">Contact</a>
      </nav>
    </div>
  )
}
