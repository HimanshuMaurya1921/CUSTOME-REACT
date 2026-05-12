// src/routes.config.js
const routes = [
  {
    path: '/',
    name: 'index',
    component: './routes/index.jsx',
    hydrate: false,
    title: 'Home',
    meta: { description: 'Welcome to our high-performance React site' }
  },
  {
    path: '/contact',
    name: 'contact',
    component: './routes/contact.jsx',
    hydrate: true,         // Interactive route
    title: 'Contact',
    meta: { description: 'Get in touch with us' }
  },
  {
    path: '/404',
    name: '404',            // Special name: will generate 404.html
    component: './routes/404.jsx',
    hydrate: false,
    title: '404 - Not Found',
    meta: { description: 'Page not found' }
  }
]
export default routes
