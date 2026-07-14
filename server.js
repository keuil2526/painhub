const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3'); // GLIBC 호환 오류 원천 차단

const app = express();
const PORT = process.env.PORT || 10000;

// 업로드 디렉토리 설정 및 자동 생성
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// SQLite 데이터베이스 연결 (better-sqlite3 방식)
const db = new Database(path.join(__dirname, 'database.db'));

// 테이블 초기화 구문 (role 컬럼 추가)
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user'
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

// 👑 서버 실행 시 'Admin' 계정이 존재하지 않는 경우 자동으로 삽입
try {
    const adminExists = db.prepare("SELECT * FROM users WHERE username = 'Admin'").get();
    if (!adminExists) {
        const insertAdmin = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)");
        insertAdmin.run('Admin', 'gksrmffhwifi0123!', 'admin');
        console.log("👑 어드민 기본 계정(Admin)이 성공적으로 활성화되었습니다.");
    }
} catch (err) {
    console.error("어드민 계정 자동 등록 중 에러 발생:", err);
}

console.log("Database initialized successfully.");

// 미들웨어 등록
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 정적 파일 라우팅 설정
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// 기본 루트 접속 시 index(painhub.html) 호출
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'painhub.html'));
});

// Multer 파일 업로드 엔진 세팅
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


/* ================= API 영역 ================= */

// 1. 회원가입 API
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: "아이디와 비밀번호를 모두 입력해 주세요." });
    }

    try {
        const stmt = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)");
        stmt.run(username, password);
        res.json({ success: true, message: "회원가입이 완료되었습니다!" });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            res.status(400).json({ success: false, message: "이미 사용 중인 아이디입니다." });
        } else {
            res.status(500).json({ success: false, message: "서버 내부 처리 실패" });
        }
    }
});

// 2. 로그인 API (유저 등급인 role 값을 브라우저로 동시 전달)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    try {
        const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password);
        if (user) {
            res.json({ 
                success: true, 
                username: user.username, 
                role: user.role || 'user', 
                message: "반갑습니다! 로그인에 성공했습니다." 
            });
        } else {
            res.status(400).json({ success: false, message: "가입 정보가 없거나 패스워드가 다릅니다." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "로그인 요청 실패" });
    }
});

// 3. 동영상 게시글 등록 API
app.post('/api/upload', upload.single('videoFile'), (req, res) => {
    const { videoTitle, videoDesc, username } = req.body;
    if (!req.file) {
        return res.status(400).json({ success: false, message: "비디오 파일을 찾을 수 없습니다." });
    }

    const filepath = `/uploads/${req.file.filename}`;

    try {
        const stmt = db.prepare("INSERT INTO videos (title, desc, filepath, username) VALUES (?, ?, ?, ?)");
        stmt.run(videoTitle, videoDesc || '', filepath, username);
        res.json({ success: true, message: "동영상이 정상적으로 게시되었습니다!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "동영상 DB 메타데이터 등록 실패" });
    }
});

// 4. 동영상 스트리밍 리스트 반환 API
app.get('/api/videos', (req, res) => {
    try {
        const videos = db.prepare("SELECT * FROM videos ORDER BY id DESC").all();
        res.json(videos);
    } catch (err) {
        res.status(500).json({ error: "비디오 피드를 읽는 중 실패했습니다." });
    }
});

// 5. 좋아요 증감 조절 API
app.post('/api/like', (req, res) => {
    const { videoId, username } = req.body;
    if (!videoId || !username) {
        return res.status(400).json({ error: "세션 유효성 인증 실패" });
    }

    try {
        const existingLike = db.prepare("SELECT * FROM likes WHERE videoId = ? AND username = ?").get(videoId, username);

        if (existingLike) {
            db.prepare("DELETE FROM likes WHERE videoId = ? AND username = ?").run(videoId, username);
            db.prepare("UPDATE videos SET likeCount = MAX(0, likeCount - 1) WHERE id = ?").run(videoId);
            res.json({ action: 'unlike', message: "동영상 추천을 철회했습니다." });
        } else {
            db.prepare("INSERT INTO likes (videoId, username) VALUES (?, ?)").run(videoId, username);
            db.prepare("UPDATE videos SET likeCount = likeCount + 1 WHERE id = ?").run(videoId);
            res.json({ action: 'like', message: "동영상을 성공적으로 추천했습니다!" });
        }
    } catch (err) {
        res.status(500).json({ error: "추천 연산 처리 도중 서버 에러" });
    }
});

// 6. 덧글 기재 API
app.post('/api/comments', (req, res) => {
    const { videoId, username, content } = req.body;
    if (!videoId || !username || !content) {
        return res.status(400).json({ error: "빈 공간을 입력해 주세요." });
    }

    try {
        const stmt = db.prepare("INSERT INTO comments (videoId, username, content) VALUES (?, ?, ?)");
        stmt.run(videoId, username, content);
        res.json({ success: true, message: "댓글이 등록되었습니다." });
    } catch (err) {
        res.status(500).json({ error: "DB 코멘트 저장 중 실패" });
    }
});

// 7. 특정 클립의 덧글 일람 제공 API
app.get('/api/comments/:videoId', (req, res) => {
    const { videoId } = req.params;
    try {
        const comments = db.prepare("SELECT * FROM comments WHERE videoId = ? ORDER BY id DESC").all(videoId);
        res.json(comments);
    } catch (err) {
        res.status(500).json({ error: "해당 영상의 덧글 데이터를 요청하지 못했습니다." });
    }
});

// 8. 동영상 삭제 API (작성 본인 또는 어드민 등급 검증 후 일괄 소멸)
app.delete('/api/videos/:id', (req, res) => {
    const videoId = req.params.id;
    const { username } = req.body;

    if (!username) {
        return res.status(401).json({ success: false, message: "권한이 없습니다. 로그인이 필요합니다." });
    }

    try {
        const video = db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId);

        if (!video) {
            return res.status(404).json({ success: false, message: "등록되지 않은 클립이거나 삭제된 파일입니다." });
        }

        // 👑 어드민 계정('Admin')이거나 업로드한 본인과 세션 명이 일치할 때만 완전 삭제 통과
        if (username !== 'Admin' && video.username !== username) {
            return res.status(403).json({ success: false, message: "관리자 혹은 영상 작성자 전용 권한입니다." });
        }

        // 데이터베이스 정합성을 유지하기 위해 관련된 자식 레코드(코멘트, 라이크) 제거 선행
        db.prepare("DELETE FROM comments WHERE videoId = ?").run(videoId);
        db.prepare("DELETE FROM likes WHERE videoId = ?").run(videoId);
        db.prepare("DELETE FROM videos WHERE id = ?").run(videoId);

        // 컨테이너 가상 드라이브에 적재된 영상 실제 확장자 파일 소거
        const absolutePath = path.join(__dirname, video.filepath);
        if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
        }

        res.json({ success: true, message: "동영상이 정상 소멸 처리되었습니다." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "삭제 처리 연산 동작 중 시스템 치명적 예외" });
    }
});


// 서버 바인딩
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(` Server starts running on port ${PORT}`);
    console.log(`=================================`);
});
