import {Http} from "@yandex-cloud/function-types/dist/src/http";
import Context from "@yandex-cloud/function-types/dist/src/context";
import {load} from "cheerio";
import {
    Driver,
    getLogger,
    getSACredentialsFromJson,
    IamAuthService,
    IAuthService,
    MetadataAuthService,
    TypedValues, Types, Ydb
} from 'ydb-sdk';

const fetch = require('node-fetch')

const token = process.env.BOT_KEY;
//const webAppUrl = process.env.WEB_URL;
const telegramUrl = "https://api.telegram.org/bot" + token;

export const logger = getLogger();

async function getDriver() {
    logger.info('Driver initializing...');
    let local = false;

    if (!process.env.ENDPOINT) {
        const dotenv = await import('dotenv');
        dotenv.config();
        local = true;
    }

    let authService: IAuthService;
    if (local) {
        const saKeyFile = process.env.SA_KEY_FILE;
        const saCredentials = getSACredentialsFromJson('./' + saKeyFile);
        authService = new IamAuthService(saCredentials);
    } else {
        authService = new MetadataAuthService();
    }

    return new Driver({ endpoint: process.env.ENDPOINT, database: process.env.DATABASE, authService });
}

async function upsertChat(driver: Driver, chat: Chat) {
    const query = `
    DECLARE $chat_id AS Utf8;
    DECLARE $enabled AS Int32;
    DECLARE $filter AS Utf8;
    DECLARE $from_id AS Utf8;
    DECLARE $from_name AS Utf8;
    DECLARE $message_thread_id AS Utf8;
    DECLARE $name AS Utf8;

    UPSERT into chats (chat_id, enabled, filter, from_id, from_name, message_thread_id, name) values ($chat_id, $enabled, $filter, $from_id, $from_name, $message_thread_id, $name);`;

    await driver.tableClient.withSession(async (session)=> {
        const preparedQuery = await session.prepareQuery(query);
        await session.executeQuery(preparedQuery, {
            '$chat_id': TypedValues.text(chat.chat_id),
            '$enabled': TypedValues.int32(chat.enabled??0),
            '$filter': TypedValues.text(chat.filter??""),
            '$from_id': TypedValues.text(chat.from_id??""),
            '$from_name': TypedValues.text(chat.from_name??""),
            '$message_thread_id': TypedValues.text(chat.message_thread_id??""),
            '$name': TypedValues.text(chat.name??"")
        });
    });
}

async function disableChat(driver: Driver, id: string) {
    const query = `
    DECLARE $chat_id AS Utf8;

    UPDATE chats set enabled=0 where chat_id=$chat_id;`;
    await driver.tableClient.withSession(async (session)=> {
        const preparedQuery = await session.prepareQuery(query);
        await session.executeQuery(preparedQuery, {
            '$chat_id': TypedValues.text(id),
        });
    });
}

async function setFilterMessageThreadIdAndEnable(driver: Driver, id: string, filter: string, message_thread_id: string) {
    const query = `
    DECLARE $chat_id AS Utf8;
    DECLARE $filter AS Utf8;
    DECLARE $message_thread_id AS Utf8;

    UPDATE chats set enabled=1, filter=$filter, message_thread_id=$message_thread_id where chat_id=$chat_id;`;
    await driver.tableClient.withSession(async (session)=> {
        const preparedQuery = await session.prepareQuery(query);
        await session.executeQuery(preparedQuery, {
            '$chat_id': TypedValues.text(id),
            '$filter': TypedValues.text(filter),
            '$message_thread_id': TypedValues.text(message_thread_id),
        });
    });
}

export const web = async (event?: Http.Event, context?: Context) => {
    const contents = JSON.parse(event?.body??"");
    const driver = await getDriver();
    if (contents.my_chat_member?.chat.id) {
        if (contents.my_chat_member.new_chat_member.status=='member') {
            const chatObj: Chat = {
                chat_id: contents.my_chat_member?.chat.id.toString(),
                filter: '',
                enabled: 0,
                name: contents.my_chat_member.chat.title,
                from_id: contents.my_chat_member.from.id.toString(),
                from_name: contents.my_chat_member.from.username,
                message_thread_id: ''
            }
            await upsertChat(driver, chatObj)
        }
        if (contents.my_chat_member.new_chat_member.status=='left') {
            await disableChat(driver, contents.my_chat_member.chat.id.toString());
        }
    } else if (contents.message?.text?.startsWith("/settings")) {
        const chats = await getChats(driver);
        const found = chats.find(x=>x.chat_id==contents.message.chat.id.toString())
        if (found) {
            const message_thread_id = contents.message.reply_to_message?.is_topic_message ? contents.message.reply_to_message?.message_thread_id.toString() : ""
            let text;
            if (found.from_id==contents.message.from.id.toString()) {
                const space=contents.message.text.indexOf(' ')
                const filter = space>0?contents.message.text.substring(contents.message.text.indexOf(' ')+1).trim():""
                if (!filter) {
                    text="Укажите фильтр, например: /settings Заречное, Заозерное, Боровое"
                } else {
                    setFilterMessageThreadIdAndEnable(driver, contents.message.chat.id.toString(), filter, message_thread_id);
                    text="Установлен фильтр: " + filter
                }
            } else {
                text="Только тот кто добавил бота может управлять им"
            }
            let chatUrl = telegramUrl + "/sendMessage?chat_id=" + contents.message.chat.id + "&text=" + encodeURIComponent(text);
            if (message_thread_id) chatUrl+="&message_thread_id=" + message_thread_id
            await fetch(chatUrl);
        }
    }

    await driver.destroy()

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/plain',
        },
        body: 'OK!'
    }
}

interface Chat {
    chat_id: string
    enabled?: number
    filter?: string
    from_id?: string
    from_name?: string
    message_thread_id?: string
    name?: string
}

interface Data {
    row_id: string // address|day_start|time_start
    address?: string
    day_start?: string
    time_start?: string
    day_end?: string
    time_end?: string
    comment?: string
}

async function getData(client: Driver): Promise<Data[]> {
    return await client.tableClient.withSession(async (session)=>{
        const data = await session.executeQuery('select row_id, address, day_start, time_start, day_end, time_end, comment from data')
        return data.resultSets[0].rows?.map(x=> ({
                row_id: x.items?.[0].textValue??"",
                address: x.items?.[1].textValue??undefined,
                day_start: x.items?.[2].textValue??undefined,
                time_start: x.items?.[3].textValue??undefined,
                day_end: x.items?.[4].textValue??undefined,
                time_end: x.items?.[5].textValue??undefined,
                comment: x.items?.[6].textValue??undefined
            })
        )??[]
    })
}

async function getChats(client: Driver): Promise<Chat[]> {
    return await client.tableClient.withSession(async (session)=>{
        const data = await session.executeQuery('select chat_id, filter, enabled, name, from_name, from_id, message_thread_id from chats')
        return data.resultSets[0].rows?.map(x=>({
                chat_id: x.items?.[0].textValue??"",
                filter: x.items?.[1].textValue??undefined,
                enabled: x.items?.[2].int32Value??undefined,
                name: x.items?.[3].textValue??undefined,
                from_name: x.items?.[4].textValue??undefined,
                from_id: x.items?.[5].textValue??undefined,
                message_thread_id: x.items?.[6].textValue??undefined
            })
        )??[]
    })
}

function filterApplied(haystack: string, needle?: string) {
    if (!needle) return true;
    const lowerHaystack = haystack.toLowerCase()
    return needle.toLowerCase().split(',').map(x=>x.trim()).some(x=>lowerHaystack.includes(x))
}

function* chunks<T>(arr: T[], n: number): Generator<T[], void> {
    for (let i = 0; i < arr.length; i += n) {
        yield arr.slice(i, i + n);
    }
}

async function replaceData(client: Driver, oldData: Data[], convertedData: Data[]) {
    //TODO: transaction??
    await client.tableClient.withSession(async (session) => {
        await session.executeQuery("delete from data", undefined/*, {txId: txId}*/)
        await session.bulkUpsert('data', TypedValues.list(Types.struct({
            row_id: Types.UTF8,
            address: Types.UTF8,
            day_start: Types.UTF8,
            time_start: Types.UTF8,
            day_end: Types.UTF8,
            time_end: Types.UTF8,
            comment: Types.UTF8
        }), convertedData) as Ydb.TypedValue)
    })
}

export const timer = async (event?: Event, context?: Context) => {
    const driver = await getDriver();

    const ds=new Date()
    ds.setDate(ds.getDate() - 1);
    const dateStart=ds.getDate().toString().padStart(2, '0') + "." + (ds.getMonth()+1).toString().padStart(2, '0') + "." + ds.getFullYear()
    const street=''
    let page=1
    let allValues=[]
    while (true) {
        let url="https://rosseti-lenenergo.ru/planned_work/?reg=&city=&date_start=" + dateStart + "&date_finish=&res=&street=" + encodeURIComponent(street)
        if (page>1) url+="&PAGEN_1=" + page
        const response = await fetch(url)
        const content = await response.text()
        const $ = load(content);
        const data=$('.planedwork table tr')
            .toArray()
            .map(tr=>$(tr).find("td").toArray().map(td=>$(td).text().trim()))
            .filter(tr=>tr.length>0)
        allValues.push(...data)
        const href = $('.page-nav-i > a:last-child').attr('href')
        let lastPage = "1"
        if (href) {
            lastPage = /PAGEN_1=(\d+)/.exec(href)?.[1] ?? "1"
        }
        page++;
        if (page>Number(lastPage)) break;
    }
    if (!allValues.length || allValues[0].length!==11) throw new Error("Format changed")

    const convertedData = allValues.map(x=>({
        row_id: x[2] + "|" + x[3] + "|" + x[4],
        address: x[2],
        day_start: x[3],
        time_start: x[4],
        day_end: x[5],
        time_end: x[6],
        comment: x[9]
    })).filter(x=>x.address)

    const data = await getData(driver)

    const map = Object.fromEntries<Data>(data.map(x=>[x.row_id, x]))
    const chats = (await getChats(driver)).filter(c=>c.enabled);

    await replaceData(driver, data, convertedData);

    for (let row of convertedData) {
        if (!map[row.row_id]) {
            for (let chatDetails of chats) {
                if (filterApplied(row.address, chatDetails.filter)) {
                    let text="Планируемое отключение: " + row.address + " с " + row.day_start
                        + " " + row.time_start + " по " + row.day_end + " " + row.time_end
                    if (row.comment) text+=" (" + row.comment + ")"
                    if (text.length>350) text=text.substring(0, 350)+"..."
                    let chatUrl = telegramUrl + "/sendMessage?chat_id=" + chatDetails.chat_id + "&text=" + encodeURIComponent(text);
                    if (chatDetails.message_thread_id) {
                        chatUrl+="&message_thread_id=" + chatDetails.message_thread_id
                    }
                    await fetch(chatUrl);
                }
            }
        }
    }

    await driver.destroy();

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/plain',
        },
        body: 'OK!'
    }
}