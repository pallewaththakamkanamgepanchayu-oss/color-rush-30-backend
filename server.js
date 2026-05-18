require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Upload folder
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, Date.now() + "_" + safeName);
  },
});
const upload = multer({ storage });

// MySQL connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

db.connect((err) => {
  if (err) {
    console.log("Database connection failed");
    console.log(err);
    return;
  }
  console.log("MySQL Connected");
});

// Test route
app.get("/", (req, res) => {
  res.send("Color Rush Backend Running Successfully");
});

// Register
app.post("/api/register", upload.single("nic_photo"), (req, res) => {
  const { name, birthday, nic, password, referred_by } = req.body;
  const nic_photo = req.file ? req.file.filename : "";

  if (!name || !birthday || !nic || !password) {
    return res.status(400).json({ message: "Fill all required fields" });
  }

  const referral_code = "CR" + Math.floor(100000 + Math.random() * 900000);

  db.query("SELECT id FROM users WHERE nic = ?", [nic], (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });

    if (rows.length > 0) {
      return res.status(400).json({ message: "NIC already registered" });
    }

    const sql = `
      INSERT INTO users 
      (name, birthday, nic, password, referred_by, referral_code, nic_photo, role, status, balance)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'pending', 0)
    `;

    db.query(
      sql,
      [name, birthday, nic, password, referred_by || "", referral_code, nic_photo],
      (err2) => {
        if (err2) {
          console.log(err2);
          return res.status(500).json({ message: "Register failed. Check users table columns." });
        }

        res.json({
          message: "Register success. Please wait for admin approval.",
          referral_code,
        });
      }
    );
  });
});

// Login user by NIC
app.post("/api/login", (req, res) => {
  const { nic, password } = req.body;

  if (!nic || !password) {
    return res.status(400).json({ message: "NIC and password required" });
  }

  db.query(
    "SELECT * FROM users WHERE nic = ? AND password = ?",
    [nic, password],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Database error" });

      if (rows.length === 0) {
        return res.status(401).json({ message: "Wrong NIC or password" });
      }

      const user = rows[0];

      if (user.status !== "approved") {
        return res.status(403).json({ message: "Your account is pending admin approval" });
      }

      res.json({ message: "Login success", user });
    }
  );
});

// Admin login by email
app.post("/api/admin/login", (req, res) => {
  const { email, password } = req.body;

  db.query(
    "SELECT * FROM users WHERE email = ? AND password = ? AND role = 'admin'",
    [email, password],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Database error" });

      if (rows.length === 0) {
        return res.status(401).json({ message: "Wrong email or password" });
      }

      res.json({ message: "Admin login success", admin: rows[0] });
    }
  );
});

// Get user
app.get("/api/user/:id", (req, res) => {
  db.query("SELECT * FROM users WHERE id = ?", [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });
    if (rows.length === 0) return res.status(404).json({ message: "User not found" });

    res.json(rows[0]);
  });
});

// Round
app.get("/api/round", (req, res) => {
  const colors = ["Yellow", "Red", "Green"];
  const now = Math.floor(Date.now() / 1000);
  const round_no = Math.floor(now / 30);
  const seconds_left = 30 - (now % 30);
  const result_color = colors[round_no % 3];

  res.json({
    current: {
      round_no,
      seconds_left,
      result_color,
    },
    previous: [
      { round_no: round_no - 1, result_color: colors[(round_no - 1) % 3] },
      { round_no: round_no - 2, result_color: colors[(round_no - 2) % 3] },
      { round_no: round_no - 3, result_color: colors[(round_no - 3) % 3] },
      { round_no: round_no - 4, result_color: colors[(round_no - 4) % 3] },
      { round_no: round_no - 5, result_color: colors[(round_no - 5) % 3] },
    ],
  });
});

// Place bet
app.post("/api/bet", (req, res) => {
  const { user_id, color, amount } = req.body;
  const betAmount = Number(amount);

  if (!user_id || !color || betAmount < 0.5) {
    return res.status(400).json({ message: "Invalid bet" });
  }

  db.query("SELECT * FROM users WHERE id = ?", [user_id], (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });
    if (rows.length === 0) return res.status(404).json({ message: "User not found" });

    const user = rows[0];

    if (Number(user.balance) < betAmount) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    const colors = ["Yellow", "Red", "Green"];
    const round_no = Math.floor(Math.floor(Date.now() / 1000) / 30);
    const result_color = colors[round_no % 3];

    const win = color === result_color;
    const payout = win ? betAmount + betAmount * 0.75 : 0;
    const profit = win ? betAmount * 0.75 : -betAmount;
    const status = win ? "Win" : "Lost";
    const newBalance = Number(user.balance) - betAmount + payout;

    db.query(
      "UPDATE users SET balance = ? WHERE id = ?",
      [newBalance, user_id],
      (err2) => {
        if (err2) return res.status(500).json({ message: "Balance update failed" });

        db.query(
          `INSERT INTO bets 
          (user_id, round_no, color, result_color, amount, payout, profit, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [user_id, round_no, color, result_color, betAmount, payout, profit, status],
          (err3) => {
            if (err3) {
              console.log(err3);
              return res.status(500).json({ message: "Bet save failed. Check bets table columns." });
            }

            res.json({
              message: status === "Win" ? "You win" : "You lost",
              status,
              result_color,
              payout,
              balance: newBalance,
            });
          }
        );
      }
    );
  });
});

// User bet history
app.get("/api/bets/:user_id", (req, res) => {
  db.query(
    "SELECT * FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 50",
    [req.params.user_id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Database error" });
      res.json(rows);
    }
  );
});

// Settings
app.get("/api/settings", (req, res) => {
  res.json({
    deposit_binance_id: process.env.BINANCE_ID || "BINANCE-ID-NOT-SET",
  });
});

// Deposit
app.post("/api/deposit", upload.single("receipt_photo"), (req, res) => {
  const { user_id, name, binance_id, amount } = req.body;
  const receipt_photo = req.file ? req.file.filename : "";

  if (!user_id || !name || !binance_id || Number(amount) < 15) {
    return res.status(400).json({ message: "Minimum deposit is $15 and all fields required" });
  }

  db.query(
    `INSERT INTO deposits 
    (user_id, name, binance_id, amount, receipt_photo, status)
    VALUES (?, ?, ?, ?, ?, 'pending')`,
    [user_id, name, binance_id, Number(amount), receipt_photo],
    (err) => {
      if (err) {
        console.log(err);
        return res.status(500).json({ message: "Deposit request failed" });
      }

      res.json({ message: "Deposit request sent. Wait for admin approval." });
    }
  );
});

// Withdraw eligibility
app.get("/api/withdraw-eligibility/:user_id", (req, res) => {
  res.json({
    ok: true,
    message: "Withdraw allowed",
    referral_count: 0,
    refs5: false,
  });
});

// Withdraw
app.post("/api/withdraw", (req, res) => {
  const { user_id, name, nic, binance_id, amount, method } = req.body;
  const withdrawAmount = Number(amount);

  if (!user_id || !name || !nic || !binance_id || withdrawAmount < 15) {
    return res.status(400).json({ message: "Minimum withdraw is $15 and all fields required" });
  }

  db.query("SELECT balance FROM users WHERE id = ?", [user_id], (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });
    if (rows.length === 0) return res.status(404).json({ message: "User not found" });

    if (Number(rows[0].balance) < withdrawAmount) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    db.query(
      `INSERT INTO withdrawals 
      (user_id, name, nic, binance_id, amount, method, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [user_id, name, nic, binance_id, withdrawAmount, method || "default"],
      (err2) => {
        if (err2) {
          console.log(err2);
          return res.status(500).json({ message: "Withdraw request failed" });
        }

        res.json({ message: "Withdraw request sent. Wait for admin approval." });
      }
    );
  });
});

// Update referral code
app.put("/api/user/:id/referral", (req, res) => {
  const { referral_code } = req.body;

  if (!referral_code) {
    return res.status(400).json({ message: "Referral code required" });
  }

  db.query(
    "UPDATE users SET referral_code = ? WHERE id = ?",
    [referral_code, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ message: "Referral update failed" });
      res.json({ message: "Referral code updated" });
    }
  );
});

// User referrals
app.get("/api/user/:id/referrals", (req, res) => {
  db.query("SELECT referral_code FROM users WHERE id = ?", [req.params.id], (err, rows) => {
    if (err || rows.length === 0) return res.json([]);

    db.query(
      "SELECT id, name, status, created_at FROM users WHERE referred_by = ? ORDER BY id DESC",
      [rows[0].referral_code],
      (err2, refs) => {
        if (err2) return res.json([]);
        res.json(refs);
      }
    );
  });
});

// Admin: get users
app.get("/api/admin/users", (req, res) => {
  db.query("SELECT * FROM users ORDER BY id DESC", (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });
    res.json(rows);
  });
});

// Admin: approve user
app.put("/api/admin/user/:id/approve", (req, res) => {
  db.query("UPDATE users SET status='approved' WHERE id=?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: "Approve failed" });
    res.json({ message: "User approved" });
  });
});

// Admin: deposits
app.get("/api/admin/deposits", (req, res) => {
  db.query("SELECT * FROM deposits ORDER BY id DESC", (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });
    res.json(rows);
  });
});

// Admin: approve deposit
app.put("/api/admin/deposit/:id/approve", (req, res) => {
  db.query("SELECT * FROM deposits WHERE id=?", [req.params.id], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).json({ message: "Deposit not found" });

    const dep = rows[0];

    if (dep.status === "approved") {
      return res.status(400).json({ message: "Already approved" });
    }

    db.query(
      "UPDATE users SET balance = balance + ? WHERE id = ?",
      [Number(dep.amount), dep.user_id],
      (err2) => {
        if (err2) return res.status(500).json({ message: "Balance update failed" });

        db.query("UPDATE deposits SET status='approved' WHERE id=?", [dep.id], (err3) => {
          if (err3) return res.status(500).json({ message: "Deposit approve failed" });
          res.json({ message: "Deposit approved and balance added" });
        });
      }
    );
  });
});

// Admin: withdrawals
app.get("/api/admin/withdrawals", (req, res) => {
  db.query("SELECT * FROM withdrawals ORDER BY id DESC", (err, rows) => {
    if (err) return res.status(500).json({ message: "Database error" });
    res.json(rows);
  });
});

// Admin: approve withdrawal
app.put("/api/admin/withdraw/:id/approve", (req, res) => {
  db.query("SELECT * FROM withdrawals WHERE id=?", [req.params.id], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).json({ message: "Withdraw not found" });

    const w = rows[0];

    if (w.status === "approved") {
      return res.status(400).json({ message: "Already approved" });
    }

    db.query("SELECT balance FROM users WHERE id=?", [w.user_id], (err2, users) => {
      if (err2 || users.length === 0) return res.status(404).json({ message: "User not found" });

      if (Number(users[0].balance) < Number(w.amount)) {
        return res.status(400).json({ message: "User balance not enough" });
      }

      db.query(
        "UPDATE users SET balance = balance - ? WHERE id=?",
        [Number(w.amount), w.user_id],
        (err3) => {
          if (err3) return res.status(500).json({ message: "Balance update failed" });

          db.query("UPDATE withdrawals SET status='approved' WHERE id=?", [w.id], (err4) => {
            if (err4) return res.status(500).json({ message: "Withdraw approve failed" });
            res.json({ message: "Withdrawal approved and balance deducted" });
          });
        }
      );
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
