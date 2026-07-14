const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3'); // GLIBC 오류 해결을 위해 better-sqlite3 사용

const app = express();
const PORT = process.env.PORT || 10000;

// 업로드 폴더 생성 (없을 경우 자동 생성)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// DB 연결 및 초기화 (better-sqlite3 방식)
const db = new Database(path.join(__dirname, 'database.db'));

// 테이블 생성
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        desc TEXT,
        filepath TEXT NOT NULL,
        username TEXT NOT NULL,
        likeCount INTEGER DEFAULT 0,
        FOREIGN KEY(username) REFERENCES users(username)
    );

    CREATE TABLE IF NOT EXISTS likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        videoId INTEGER,
        username TEXT,
        UNIQUE(videoId, username),
        FOREIGN KEY(videoId) REFERENCES videos(id)
    );

    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        videoId INTEGER,
        username TEXT,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(videoId) REFERENCES videos(id)
    );
`);
console.log("Database initialized successfully.");

// 미들웨어 설정
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 정적 파일 제공 (프론트엔드 HTML 및 업로드된 동영상 파일)
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// 메인 루트 접속 시 painhub.html 반환
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'painhub.html'));
});

// 파일 업로드 설정 (Multer)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

/* ================= API 라우트 ================= */

// 1. 회원가입 API
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: "아이디와 비밀번호를 모두 입력해주세요." });
    }

    try {
        const stmt = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)");
        stmt.run(username, password);
        res.json({ success: true, message: "회원가입이 완료되었습니다!" });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            res.status(400).json({ success: false, message: "이미 존재하는 아이디입니다." });
        } else {
            res.status(500).json({ success: false, message: "서버 오류가 발생했습니다." });
        }
    }
});

// 2. 로그인 API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    try {
        const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password);
        if (user) {
            res.json({ success: true, username: user.username, message: "로그인 성공!" });
        } else {
            res.status(400).json({ success: false, message: "아이디 또는 비밀번호가 틀렸습니다." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "서버 오류가 발생했습니다." });
    }
});

// 3. 동영상 업로드 API
app.post('/api/upload', upload.single('videoFile'), (req, res) => {
    const { videoTitle, videoDesc, username } = req.body;
    if (!req.file) {
        return res.status(400).json({ success: false, message: "동영상 파일을 선택해 주세요." });
    }

    const filepath = `/uploads/${req.file.filename}`;

    try {
        const stmt = db.prepare("INSERT INTO videos (title, desc, filepath, username) VALUES (?, ?, ?, ?)");
        stmt.run(videoTitle, videoDesc || '', filepath, username);
        res.json({ success: true, message: "동영상이 성공적으로 게시되었습니다!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "서버 DB 등록 오류가 발생했습니다." });
    }
});

// 4. 동영상 목록 조회 API
app.get('/api/videos', (req, res) => {
    try {
        const videos = db.prepare("SELECT * FROM videos ORDER BY id DESC").all();
        res.json(videos);
    } catch (err) {
        res.status(500).json({ error: "동영상을 불러오는 중 오류가 발생했습니다." });
    }
});

// 5. 좋아요(Like) 토글 API
app.post('/api/like', (req, res) => {
    const { videoId, username } = req.body;
    if (!videoId || !username) {
        return res.status(400).json({ error: "잘못된 접근입니다." });
    }

    try {
        // 이미 좋아요를 눌렀는지 확인
        const existingLike = db.prepare("SELECT * FROM likes WHERE videoId = ? AND username = ?").get(videoId, username);

        if (existingLike) {
            // 좋아요 취소
            db.prepare("DELETE FROM likes WHERE videoId = ? AND username = ?").run(videoId, username);
            db.prepare("UPDATE videos SET likeCount = MAX(0, likeCount - 1) WHERE id = ?").run(videoId);
            res.json({ action: 'unlike', message: "좋아요를 취소했습니다." });
        } else {
            // 좋아요 등록
            db.prepare("INSERT INTO likes (videoId, username) VALUES (?, ?)").run(videoId, username);
            db.prepare("UPDATE videos SET likeCount = likeCount + 1 WHERE id = ?").run(videoId);
            res.json({ action: 'like', message: "동영상을 추천했습니다." });
        }
    } catch (err) {
        res.status(500).json({ error: "서버 처리 중 오류가 발생했습니다." });
    }
});

// 6. 댓글 등록 API
app.post('/api/comments', (req, res) => {
    const { videoId, username, content } = req.body;
    if (!videoId || !username || !content) {
        return res.status(400).json({ error: "빈칸을 채워주세요." });
    }

    try {
        const stmt = db.prepare("INSERT INTO comments (videoId, username, content) VALUES (?, ?, ?)");
        stmt.run(videoId, username, content);
        res.json({ success: true, message: "댓글이 등록되었습니다." });
    } catch (err) {
        res.status(500).json({ error: "댓글 저장 중 오류가 발생했습니다." });
    }
});

// 7. 특정 동영상의 댓글 조회 API
app.get('/api/comments/:videoId', (req, res) => {
    const { videoId } = req.params;
    try {
        const comments = db.prepare("SELECT * FROM comments WHERE videoId = ? ORDER BY id DESC").all(videoId);
        res.json(comments);
    } catch (err) {
        res.status(500).json({ error: "댓글을 가져오지 못했습니다." });
    }
});

// 서버 실행
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(` Server is running on port ${PORT}`);
    console.log(`=================================`);
});
