const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const ClickSend = require('clicksend');


const app = express();
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const dbPath = path.join(__dirname, 'healthcenter.db');
const db = new sqlite3.Database(dbPath);

// Simple in-memory sessions (for demo; use proper session store in prod)
const sessions = new Map();

// Force seed users on startup
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('Table creation error:', err);
  });

  // Always seed default user (INSERT OR IGNORE)
  db.run("INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', '123', 'admin')", function(err) {
    if (err) {
      console.error('Seed error:', err);
    } else {
      console.log('Default admin user ready: username=admin, password=123');
    }
  });

  // Other tables...
  db.run(`CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    age INTEGER NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT NOT NULL,
    service TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    additional_info TEXT,
    status TEXT DEFAULT 'Pending',
    doctor_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doctor_id) REFERENCES staff(id)
  )`);

  // Add columns if they don't exist (for existing databases)
  db.run(`ALTER TABLE appointments ADD COLUMN phone TEXT`, (err) => {});
  db.run(`ALTER TABLE appointments ADD COLUMN email TEXT`, (err) => {});
  db.run(`ALTER TABLE appointments ADD COLUMN doctor_id INTEGER`, (err) => {});

  db.run(`CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    age INTEGER NOT NULL,
    address TEXT NOT NULL,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    is_active INTEGER DEFAULT 1
  )`);

  db.get('SELECT COUNT(*) as count FROM services', (err, row) => {
    if (row && row.count === 0) {
      [['General Check-up', 'Routine health examination'], ['Vaccination', 'Free vaccines available'], ['Blood Pressure Check', 'Free monitoring service'], ['Dental Check-up', 'Basic dental services']].forEach(([name, desc]) => {
        db.run('INSERT INTO services (name, description) VALUES (?, ?)', [name, desc]);
      });
      console.log('Seeded default services');
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    phone TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.get('SELECT COUNT(*) as count FROM staff', (err, row) => {
    if (row && row.count === 0) {
      db.run('INSERT INTO staff (name, role, phone, status) VALUES (?, ?, ?, ?)', ['Dr. Reyes', 'Doctor', '0917-123-4567', 'active']);
      db.run('INSERT INTO staff (name, role, phone, status) VALUES (?, ?, ?, ?)', ['Nurse Garcia', 'Nurse', '0917-234-5678', 'active']);
      console.log('Seeded default staff');
    }
  });
});

// Simple auth middleware
const requireAuth = (req, res, next) => {
  const sessionId = req.headers['authorization'] || req.cookies?.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Auth endpoints (public)
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  console.log('Login attempt:', username); // Debug log
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
    if (err) {
      console.error('DB error:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log('User found:', row ? 'yes' : 'no'); // Debug
    if (row) {
      const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      sessions.set(sessionId, { userId: row.id, username: row.username, role: row.role });
      res.json({ 
        success: true, 
        user: row,
        sessionId: sessionId
      });
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  });
});

app.post('/api/signup', (req, res) => {
  const { username, password, role = 'admin' } = req.body;
  db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, password, role], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ id: this.lastID, message: 'User created successfully' });
  });
});

// Protected endpoints (services, staff, appointments, patients, stats)
app.get('/api/services', requireAuth, (req, res) => {
  db.all('SELECT * FROM services ORDER BY name', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/services', requireAuth, (req, res) => {
  const { name, description } = req.body;
  db.run('INSERT INTO services (name, description) VALUES (?, ?)', [name, description || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, message: 'Service added' });
  });
});

app.put('/api/services/:id', requireAuth, (req, res) => {
  const { name, description } = req.body;
  db.run('UPDATE services SET name = ?, description = ? WHERE id = ?', [name, description || '', req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Service updated' });
  });
});

app.delete('/api/services/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM services WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Service deleted' });
  });
});

app.get('/api/staff', requireAuth, (req, res) => {
  db.all('SELECT * FROM staff ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/doctors', requireAuth, (req, res) => {
  db.all('SELECT * FROM staff WHERE role = ? ORDER BY name', ['Doctor'], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/staff', requireAuth, (req, res) => {
  const { name, role, phone } = req.body;
  db.run('INSERT INTO staff (name, role, phone) VALUES (?, ?, ?)', [name, role, phone || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, message: 'Staff added' });
  });
});

app.put('/api/staff/:id', requireAuth, (req, res) => {
  const { name, role, phone } = req.body;
  db.run('UPDATE staff SET name = ?, role = ?, phone = ? WHERE id = ?', [name, role, phone || '', req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Staff updated' });
  });
});

app.delete('/api/staff/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM staff WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Staff deleted' });
  });
});

app.get('/api/appointments', requireAuth, (req, res) => {
  db.all(`
    SELECT a.*, s.name as doctor_name, s.role as doctor_role 
    FROM appointments a 
    LEFT JOIN staff s ON a.doctor_id = s.id 
    ORDER BY a.date DESC, a.time DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/appointments', (req, res) => {
  const { name, age, phone, email, address, service, doctor_id, date, time, additional_info } = req.body;
  db.run(
    'INSERT INTO appointments (name, age, phone, email, address, service, doctor_id, date, time, additional_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [name, age, phone || '', email || '', address, service, doctor_id || null, date, time, additional_info || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Send SMS confirmation if phone provided and credentials set
      if (phone && process.env.CLICKSEND_USERNAME && process.env.CLICKSEND_KEY) {
        const sms = new ClickSend.SMSApi();
        sms.configuration.username = process.env.CLICKSEND_USERNAME;
        sms.configuration.apiKey = process.env.CLICKSEND_KEY;
        
        const message = `Barangay Health Center: Hi ${name}, your appointment for ${service} on ${date} at ${time} is confirmed. Address: ${address.slice(0,50)}...`;
        
        const smsMessage = new ClickSend.SmsMessage();
        smsMessage.source = 'sdk';
        smsMessage.from = 'BarangayHC';
        smsMessage.to = phone.startsWith('+63') || phone.startsWith('0') ? phone : '+63' + phone.replace(/^\+?63/, '');
        smsMessage.body = message;
        
        const messages = new ClickSend.SmsMessageArray();
        messages.messages = [smsMessage];
        
        sms.smsAsync(messages).then((data) => {
          console.log('SMS sent successfully:', data);
        }).catch((error) => {
          console.error('SMS send failed:', error);
        });
      } else if (phone) {
        console.log('SMS skipped: missing credentials or invalid phone');
      }
      
      res.json({ id: this.lastID, message: 'Appointment booked successfully' });
    }
  );
});

app.put('/api/appointments/:id', requireAuth, (req, res) => {
  const { status, doctor_id } = req.body;
  db.run('UPDATE appointments SET status = ?, doctor_id = ? WHERE id = ?', [status, doctor_id || null, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Appointment updated' });
  });
});

app.delete('/api/appointments/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM appointments WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Appointment deleted' });
  });
});

app.get('/api/patients', requireAuth, (req, res) => {
  db.all('SELECT * FROM patients ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/patients', requireAuth, (req, res) => {
  const { name, age, address, phone } = req.body;
  db.run(
    'INSERT INTO patients (name, age, address, phone) VALUES (?, ?, ?, ?)',
    [name, age, address, phone || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Patient added' });
    }
  );
});

app.put('/api/patients/:id', requireAuth, (req, res) => {
  const { name, age, address, phone } = req.body;
  db.run('UPDATE patients SET name = ?, age = ?, address = ?, phone = ? WHERE id = ?', 
    [name, age, address, phone || '', req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Patient updated' });
  });
});

app.delete('/api/patients/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM patients WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Patient deleted' });
  });
});

app.get('/api/stats', requireAuth, (req, res) => {
  db.get('SELECT COUNT(*) as total_patients FROM patients', [], (err, patientCount) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const today = new Date().toISOString().split('T')[0];
    db.get('SELECT COUNT(*) as today_appointments FROM appointments WHERE date = ?', [today], (err, appointmentCount) => {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get('SELECT COUNT(*) as total_appointments FROM appointments', [], (err, totalAppointments) => {
        if (err) return res.status(500).json({ error: err.message });
        
        res.json({
          total_patients: patientCount.total_patients || 0,
          today_appointments: appointmentCount.today_appointments || 0,
          total_appointments: totalAppointments.total_appointments || 0
        });
      });
    });
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Default login: admin/123`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

