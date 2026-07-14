const express = require('express');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

let db;
(async () => {
    db = await open({
        filename: './database.db',
        driver: sqlite3.Database
    });

    // 1. 유저 테이블 생성
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL
        )
    `);

    // 2. 비디오 테이블 생성 (작성자 username 컬럼 추가)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            desc TEXT,
            filepath TEXT NOT NULL,
            username TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 3. 댓글 테이블 생성
    await db.exec(`
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 4. 좋아요 테이블 생성 (중복 좋아요 방지)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS likes (
            video_id INTEGER,
            username TEXT,
            PRIMARY KEY (video_id, username)
        )
    `);

    console.log("All DB Tables Initialized.");
})();

// Multer 설정
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'uploads/'); },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

/* ==================== API 영역 ==================== */

// [회원가입]
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const userExists = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (userExists) {
            return res.json({ success: false, message: "이미 존재하는 아이디입니다." });
        }
        await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password]);
        res.json({ success: true, message: "회원가입이 완료되었습니다!" });
    } catch (e) {
        res.status(500).json({ success: false, message: "서버 오류" });
    }
});

// [로그인]
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
        if (!user) {
            return res.json({ success: false, message: "아이디 또는 비밀번호가 틀렸습니다." });
        }
        res.json({ success: true, username: user.username });
    } catch (e) {
        res.status(500).json({ success: false, message: "서버 오류" });
    }
});

// [동영상 업로드] (로그인 유저 정보 필수 파라미터로 처리)
app.post('/api/upload', upload.single('videoFile'), async (req, res) => {
    try {
        const { videoTitle, videoDesc, username } = req.body;
        const file = req.file;

        if (!username || username === "null") {
            return res.status(401).json({ success: false, message: "로그인이 필요한 서비스입니다." });
        }
        if (!file) {
            return res.status(400).json({ success: false, message: "파일이 없습니다." });
        }

        const filepath = `/uploads/${file.filename}`;
        await db.run(
            'INSERT INTO videos (title, desc, filepath, username) VALUES (?, ?, ?, ?)',
            [videoTitle, videoDesc, filepath, username]
        );

        res.json({ success: true, message: "성공적으로 업로드되었습니다!" });
    } catch (error) {
        res.status(500).json({ success: false, message: "서버 오류" });
    }
});

// [동영상 목록 조회] (좋아요 수 포함)
app.get('/api/videos', async (req, res) => {
    try {
        const videos = await db.all(`
            SELECT v.*, COUNT(l.username) as likeCount 
            FROM videos v 
            LEFT JOIN likes l ON v.id = l.video_id 
            GROUP BY v.id 
            ORDER BY v.id DESC
        `);
        res.json(videos);
    } catch (error) {
        res.status(500).json({ success: false, message: "서버 오류" });
    }
});

// [댓글 토글/조회]
app.get('/api/comments/:videoId', async (req, res) => {
    try {
        const comments = await db.all('SELECT * FROM comments WHERE video_id = ? ORDER BY id ASC', [req.params.videoId]);
        res.json(comments);
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/comments', async (req, res) => {
    const { videoId, username, content } = req.body;
    if(!username) return res.status(401).json({ success: false, message: "로그인이 필요합니다." });
    try {
        await db.run('INSERT INTO comments (video_id, username, content) VALUES (?, ?, ?)', [videoId, username, content]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// [좋아요 토글]
app.post('/api/like', async (req, res) => {
    const { videoId, username } = req.body;
    if(!username) return res.status(401).json({ success: false, message: "로그인이 필요합니다." });
    try {
        const alreadyLiked = await db.get('SELECT * FROM likes WHERE video_id = ? AND username = ?', [videoId, username]);
        if (alreadyLiked) {
            await db.run('DELETE FROM likes WHERE video_id = ? AND username = ?', [videoId, username]);
            return res.json({ success: true, action: 'unlike' });
        } else {
            await db.run('INSERT INTO likes (video_id, username) VALUES (?, ?)', [videoId, username]);
            return res.json({ success: true, action: 'like' });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.listen(PORT, () => { console.log(`Server running at http://localhost:${PORT}`); });
