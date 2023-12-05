const express = require('express');
const OpenAI = require('openai');
const ytdl = require('ytdl-core');
const fs = require('fs');
const { unlink } = require('fs');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql');
const crypto = require('crypto');
const axios = require('axios');
const { configDotenv } = require('dotenv');
configDotenv();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// handle cors
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers',
        '*'
    );
    if (req.method === 'OPTIONS') {
        res.header('Access-Control-Allow-Methods', 'PUT, POST, PATCH, DELETE, GET, OPTIONS')
        return res.status(200).json({});
    }
    next();
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

var conn = mysql.createPool({
    host: "103.55.39.181",
    user: "pesanped_admin",
    port: "3306",
    password: "U@HYemwU@7Ku9sN",
    database: "pesanped_stadiumz"
})

conn.on('error', (err) => {
    console.error(err);
});

app.post('/api/generate/topic', async (req, res) => {
    try {
        // get token for bearer authentication from request header
        let token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
        token = token.split('|')[1];
        if (!token) {
            return res.status(401).json({
                message: 'Unauthorized'
            });
        }

        // hash 256 the token
        token = crypto.createHash('sha256').update(token).digest('hex');
        let user = await decryptToken(token, res);
        let topic = req.body.topic;
        let prompt = `You are a teacher who is teaching a class about ${topic}. You are trying to explain the concept of ${topic} to your students. Give a learning path about ${topic} to your students. give max 10 of subtopics about ${topic}. just answer with json with format array of string without making any key. eg return is ['subtopic1', 'subtopic2', 'subtopic3'].`


        const chatCompletion = await openai.chat.completions.create({
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: `i want to learn about ${topic}` },
            ],
            model: 'gpt-3.5-turbo-1106',
            temperature: 0
        });

        let subtopics = JSON.parse(chatCompletion.choices[0].message.content);
        conn.getConnection(function (err, connection) {
            if (err) throw err;
            connection.query("INSERT INTO topics (topic, user_id) VALUES (?, ?)", [topic, user.id], function (err, result, fields) {
                if (err) throw err;

                // insert subtopics to database
                subtopics.forEach(async (subtopic) => {
                    // check if index 0 then set is_locked to false
                    if (subtopics.indexOf(subtopic) == 0) {
                        connection.query("INSERT INTO subtopics (subtopic, topic_id, is_locked, created_at) VALUES (?, ?, ?, ?, ?)", [subtopic, result.insertId, false, new Date()]);
                        return;
                    }
                    connection.query("INSERT INTO subtopics (subtopic, topic_id, created_at) VALUES (?, ?, ?)", [subtopic, result.insertId, new Date()]);
                });
            });
            connection.release();
        });
        // insert topic to database


        return res.json({
            status: 'success',
            message: 'Topic and subtopics generated successfully',
            data: subtopics
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({
            message: 'Internal server error'
        });
    }
})

app.post('/api/generate/detail/:subtopic_id', async (req, res) => {
    try {
        // get token for bearer authentication from request header
        let token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
        token = token.split('|')[1];
        if (!token) {
            return res.status(401).json({
                message: 'Unauthorized'
            });
        }

        // hash 256 the token
        token = crypto.createHash('sha256').update(token).digest('hex');
        let user = await decryptToken(token, res);
        let subtopic_id = req.params.subtopic_id;
        let subtopic = await getSubtopic(conn, subtopic_id);
        if (!subtopic) {
            return res.status(404).json({
                status: 'failed',
                message: 'Subtopic not found'
            });
        }
        // get youtube video based on subtopic using youtube api
        // url encode 
        subtopic = encodeURIComponent(subtopic);
        let url = await axios.get(`https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&q=${subtopic}&videoDuration=medium&type=video&key=${process.env.YOUTUBE_API_KEY}`);
        let video_id = url.data.items[0].id.videoId;
        let video_url = `https://www.youtube.com/watch?v=${video_id}`;
        conn.getConnection(function (err, connection) {
            connection.query("UPDATE subtopics SET youtube_link = ? WHERE id = ?", [video_url, subtopic_id], function (err, result, fields) {
                if (err) throw err;
            });
            connection.release();
        });

        let videoName = uuidv4() + '.webm';
        // get youtube video and convert to mp3
        await ytdl(video_url, { filter: 'audioonly' })
            .pipe(fs.createWriteStream(videoName))
            .on('finish', async () => {
                console.log('video downloaded');
                const audio = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(videoName),
                    model: 'whisper-1'
                });
                // let description = await openai.chat.completions.create({
                //     messages: [
                //         { role: 'system', content: "Make short 100 character description or resume the given of transcript. just return the result of description dont give another answer." },
                //         { role: 'user', content: `transcript: ${audio.text}` },
                //     ],
                //     model: 'gpt-3.5-turbo-1106',
                //     temperature: 0
                // })
                // description = description.choices[0].message.content;
                conn.getConnection(function (err, connection) {
                    connection.query("UPDATE subtopics SET description = ?, youtube_transcript = ? WHERE id = ?", ["desc", audio.text, subtopic_id], function (err, result, fields) {
                        if (err) throw err;
                    });
                    connection.release();
                });

                unlink(videoName, (err) => {
                    if (err) {
                        console.log(err);
                    }
                });

                return res.json({
                    status: 'success',
                    message: 'Detail generated successfully',
                });
            });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            message: 'Internal Server Error'
        });
    }
});

async function getSubtopic(conn, subtopic_id) {
    return new Promise((resolve, reject) => {
        conn.getConnection(function (err, connection) {
            if (err) console.log('[MYSQL ERROR]', err);
            connection.query("SELECT * FROM subtopics WHERE id = ?", [subtopic_id], function (err, result, fields) {
                connection.release();
                if (err) console.log('[MYSQL ERROR]', err);
                if(result.length > 0){
                    resolve(result[0].subtopic);
                }else{
                    resolve(null);
                }
            });
        });
    });
}

function decryptToken(token, res) {
    return new Promise((resolve, reject) => {
        // query personal_access_tokens table wheren token is equal
        conn.getConnection(function (err, connection) {
            connection.query("SELECT * FROM personal_access_tokens WHERE token = ?", [token], function (err, result, fields) {
                if (err) reject(err);
                var user_token = result[0];

                if (!user_token) {
                    return res.status(401).json({
                        message: 'Unauthorized'
                    });
                }

                // query users table where id is equal to the user_id in the personal_access_tokens table
                connection.query("SELECT id,name,email FROM users WHERE id = ?", [user_token.tokenable_id], function (err, result, fields) {
                    if (err) reject(err);
                    resolve(result[0]);
                    connection.release();
                });
            });
        });
    });
}



app.listen(PORT, () => {
    console.log(`Server listening on port http://localhost:${PORT}`);
});
