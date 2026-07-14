const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const cloudinary = require('cloudinary').v2; // ☁️ Cloudinary SDK 로드

const app = express();
const PORT = process.env.PORT || 10000;

/* ================= Cloudinary 인증 설정 ================= */
// 💡 [필독]기에 본인의 Cloudinary 대시보드 정보들을 입력해 주세요!
cloudinary.config({
    cloud_name: 'yvg67ldu', // 클라우드 이름 기재
    api_key: '214413634643912',       // API Key 기재
    api_secret: 'MhFGjCs8neWx7httbH_or7zvY2E'  // API Secret 기재
});
/* ======================================================= */

// SQLite 데이터베이스 연결
const db = new Database(path.join(__dirname, 'database.db'));

// 테이블 초기화 구문
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

// 'Admin' 계정 자동 삽입
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'painhub.html'));
});

// 메모리 보관형 Multer 설정 (서버 가상 하드디스크 미사용)
const storage = multer.memoryStorage();
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

// 2. 로그인 API
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

// 3. 동영상 게시글 등록 API (Cloudinary Stream 업로드 버전)
app.post('/api/upload', upload.single('videoFile'), (req, res) => {
    const { videoTitle, videoDesc, username } = req.body;
    if (!req.file) {
        return res.status(400).json({ success: false, message: "비디오 파일을 찾을 수 없습니다." });
    }

    // 파일 버퍼 스트림을 Cloudinary로 직접 전송하는 함수 정의
    const uploadStream = () => {
        return new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    resource_type: 'video', // 동영상 타입 강제 지정
                    folder: 'painhub_videos' // Cloudinary 보관 폴더명 지정
                },
                (error, result) => {
                    if (error) return reject(error);
                    resolve(result);
                }
            );
            stream.end(req.file.buffer); // 버퍼 전달 후 스트림 종료
        });
    };

    uploadStream()
        .then((result) => {
            // Cloudinary에서 반환해 준 보안 스트리밍 URL (secure_url)을 DB에 저장
            const secureUrl = result.secure_url;

            const stmt = db.prepare("INSERT INTO videos (title, desc, filepath, username) VALUES (?, ?, ?, ?)");
            stmt.run(videoTitle, videoDesc || '', secureUrl, username);

            res.json({ success: true, message: "동영상이 Cloudinary 클라우드에 영구 업로드되었습니다!" });
        })
        .catch((err) => {
            console.error("Cloudinary 업로드 오류 발생:", err);
            res.status(500).json({ success: false, message: "클라우드 스토리지 전송 실패" });
        });
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

// 8. 동영상 삭제 API (Cloudinary에서도 영구 파괴 처리)
app.delete('/api/videos/:id', async (req, res) => {
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

        if (username !== 'Admin' && video.username !== username) {
            return res.status(403).json({ success: false, message: "관리자 혹은 영상 작성자 전용 권한입니다." });
        }

        // A. DB 내 메타데이터 완전히 지우기
        db.prepare("DELETE FROM comments WHERE videoId = ?").run(videoId);
        db.prepare("DELETE FROM likes WHERE videoId = ?").run(videoId);
        db.prepare("DELETE FROM videos WHERE id = ?").run(videoId);

        // B. Cloudinary Storage에서 해당 비디오 완전히 날리기
        // 예시 URL: https://res.cloudinary.com/cloudname/video/upload/v12345/painhub_videos/file_id.mp4
        // 필요한 Public ID 형태: 'painhub_videos/file_id'
        const urlParts = video.filepath.split('/');
        const folderIndex = urlParts.indexOf('painhub_videos');
        
        if (folderIndex !== -1) {
            // "painhub_videos/실제파일명"만 파싱하고 뒤의 확장자(.mp4)는 잘라냅니다.
            const publicIdWithExtension = urlParts.slice(folderIndex).join('/');
            const publicId = publicIdWithExtension.substring(0, publicIdWithExtension.lastIndexOf('.'));

            await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
        }

        res.json({ success: true, message: "동영상이 로컬 DB 및 Cloudinary 클라우드 스페이스에서 완전히 삭제되었습니다." });
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
