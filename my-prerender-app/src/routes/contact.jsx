// src/routes/contact.jsx
import React, { useState } from 'react'
import './contact.css'

export default function Contact() {
  const [count, setCount] = useState(0)

  return (
    <div>
      <h1>Contact Us</h1>
      <p>This page is pre-rendered and then <strong>hydrated</strong> in the browser.</p>
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          Interactivity Check: Count is {count}
        </button>
      </div>
      <nav>
        <a href="/">Back Home</a>
      </nav>
    </div>
  )
}
