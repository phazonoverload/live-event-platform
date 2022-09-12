require('dotenv').config()
const express = require('express')
const opentok = require('opentok')
const Airtable = require('airtable')
const { base } = require('airtable')

const app = express()
app.use(express.static('public'))
app.use(express.json())
app.set('view engine', 'html')
app.engine('html', require('hbs').__express)

const OT = new opentok(process.env.OPENTOK_API_KEY, process.env.OPENTOK_API_SECRET)
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID)

const tables = [
    { name: 'meta', type: 'keyValue' },
    { name: 'sponsors', type: 'records' },
    { name: 'nav', type: 'records' },
]

app.get('/', async (_, res) => {
    try {
        const base = await getAllTables()
        res.render('index', base)
    } catch(e) {
        console.log(e)
        res.send(e)
    }

})

app.get('/producer', async (_, res) => {
    const base = await getAllTables()
    res.render('producer', base)
})

// Generate OpenTok token for chat
app.get('/chat-token', (_, res) => {
    const apiKey = process.env.OPENTOK_API_KEY
    const sessionId = process.env.OPENTOK_API_SESSION_ID
    const token = OT.generateToken(sessionId, { role: 'publisher' })
    res.json({ apiKey, sessionId, token })
})

app.post('/delete-message', async (req, res) => {
    try {
        if(req.body.key != process.env.ADMIN_KEY) throw 'Incorrect key'
        delete req.body.key

        if(req.body.id) await updateRecord('reported_messages', req.body.id, { outcome: 'deleted' })
        delete req.body.id

        await addMessage('deleted_messages', { ...req.body, deleted: new Date() })
        OT.signal(process.env.OPENTOK_API_SESSION_ID, null, { type: 'deleteMessage', data: req.body.sent }, (error) => { if(error) throw error })
        res.json({ message: 'Deleted message' })
    } catch(error) {
        res.json({ error })
    }
})

app.post('/report-update', async (req, res) => {
    try {
        if(req.body.key != process.env.ADMIN_KEY) throw 'Incorrect key'
        delete req.body.key
        if(req.body.id) await updateRecord('reported_messages', req.body.id, req.body.update)
        res.json({ message: 'Updated report' })
    } catch(error) {
        res.json({ error })
    }
})

app.post('/report-message', async (req, res) => {
    try {
        await addMessage('reported_messages', { ...req.body, reported: new Date() })
        res.json({ message: 'Reported message' })
    } catch(error) {
        res.json({ error })
    }
})

app.post('/update-state', async (req, res) => {
    try {
        if(req.body.key != process.env.ADMIN_KEY) throw 'Incorrect key'
        delete req.body.key
        const meta = await getTable(tables.find(t => t.name == 'meta'), { returnId: true })
        let payload = Object.entries(meta).map(([k, v]) => ({id: v.id, fields: { key: k, value: req.body[k] }}))
        for(let property of ['event_name', 'event_description', 'streamtext', 'font_cdn', 'font_family', 'header_color_bg', 'header_color_text', 'page_color_bg', 'page_color_text']) {
            payload = payload.filter(p => p.fields.key != property)
        }

        airtable('meta').update(payload, (error, records) => {
            if(error) {console.log(error); throw error;}
            OT.signal(process.env.OPENTOK_API_SESSION_ID, null, { type: 'updateState', data: req.body }, (error) => { if(error) throw error })
            res.json({ message: 'Updated state' })
        })
    } catch(error) {
        console.log({ error })
        res.json({ error })
    }
})

app.get('/state', async (_, res) => {
    try {
        const base = await getAllTables()
        res.json(base)
    } catch(error) {
        res.json({ error })
    }
})

app.get('/reports', async (req, res) => {
    if(req.query.key != process.env.ADMIN_KEY) return res.json({ error: 'Incorrect key' })
    let reports = await getTable({ name: 'reported_messages'})
    reports = reports.filter(report => !report.outcome)
    res.json(reports)
})

function getAllTables() {
    return new Promise(async (resolve, reject) => {
        let base = {}
        for(let table of tables) {
            base[table.name] = await getTable(table).catch(e => reject(e))
        }
        resolve(base)
    })
}

function getTable(table, opts = {}) {
    return new Promise((resolve, reject) => {
        airtable(table.name).select().firstPage((err, records) => {
            if(err) { reject(err) }
            let toReturn = flattenRecords(records)
            if(table.type == 'keyValue') toReturn = tableToObject(toReturn, opts)
            resolve(toReturn)
        })
    })
}

function addMessage(table, data) {
    return new Promise((resolve, reject) => {
        airtable(table).create(data, err => {
            if (err) reject(err)
            resolve()
        })
    })
}

function updateRecord(table, id, data) {
    return new Promise((resolve, reject) => {
        airtable(table).update(id, data, err => {
            if (err) reject(err)
            resolve()
        })
    })
}

const port = process.env.PORT || 3000
app.listen(port, console.log(`Listening on port ${port} at ${new Date().toISOString()}`))

/*
 * UTILITIES
 */

function flattenRecords(table) {
    return table.map(record => {
        const { id, createdTime, fields } = record
        return { id, createdTime, ...fields }
    })
}

function tableToObject(table, opts = {}) {
    const obj = {}
    for (let record of table) {
        obj[record.key] = record.value
        if(opts.returnId) {
            obj[record.key] = {
                id: record.id,
                value: record.value
            }
        }
    }
    return obj
}
