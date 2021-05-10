const { MongoClient } = require('mongodb')

function getRequest (url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? require('https') : require('http')
        const request = lib.get(url, response => {
            if (response.statusCode < 200 || response.statusCode > 299) {
                reject(new Error('Failed to load, status code: ' + response.statusCode))
             }
            const body = []
            response.on('data', chunk => body.push(chunk))
            response.on('end', () => resolve(body.join('')))
          })
        request.on('error', err => reject(err))
    })
}

function getApiOrders (url, limit, date, after ) {
    return new Promise((resolve, reject) => {
        let addToUrl = ''
        if (limit) addToUrl = addToUrl + '&limit=' + limit
        let direction
        after ? direction =  '&after=' : direction =  '&before='
        if (date) addToUrl = addToUrl + direction + Math.round(new Date(date).getTime()/1000)
        getRequest (url + addToUrl)
        .then(data => {
            const dataObj = JSON.parse(data)
            if (dataObj.success) {
                resolve (dataObj.params.orderList)
            } else {
                reject(new Error('Failed to load'))
            }
          })
        .catch (err => reject(err) )
    })
}

async function getOrdersData(eshopUri) {
    let ordersList= []
    let productList= []
    try {
        //add fresh and update new, paid and unpaid orders
        const ordersToUpdate = await ordersCollection.find(
            { vyrizeno : { $in: ['c','d','n','g'] } }, 
            { sort: {'id_order': -1}, projection: { '_id': 0, 'id_order': 1}})
            .toArray()
        const firstDbOrderId = ordersToUpdate[ordersToUpdate.length-1]['id_order']
        const lastDbOrder = await ordersCollection.findOne({}, {sort: {id_order: -1}, projection: { '_id': 0, 'id_order': 1}})
        const lastDbOrderId = lastDbOrder.id_order
        const lastApiOrder = await getApiOrders(eshopUri,1)
        const lastApiOrderId = lastApiOrder[0].id_order
        let ordersCount = lastApiOrderId - firstDbOrderId + 1
        if (ordersCount > 99) ordersCount = 99 //TODO implement page read from api
        let newOrdersCount = lastApiOrderId - lastDbOrderId
        if (newOrdersCount > 99) newOrdersCount = 99 //TODO implement page read from api
        let apiOrders = await getApiOrders(eshopUri, ordersCount)
        const freshApiOrders = apiOrders.slice(0, newOrdersCount)
        if (freshApiOrders.length > 0) {
            let result = await ordersCollection.insertMany(freshApiOrders)
            console.log(`${result.insertedCount} fresh orders inserted`)
        }
        let updatedOrders = 0
        for (let i=0; i<ordersToUpdate.length; i++) {
            let orderIdToUpdate = ordersToUpdate[i]['id_order']
            let orderIndex = apiOrders.findIndex(e => e['id_order'] === orderIdToUpdate)
            let result
            if (orderIndex !== -1) {
                result = await ordersCollection.replaceOne(
                    { 'id_order' : apiOrders[orderIndex]['id_order'] }, apiOrders[orderIndex])
                if (result.modifiedCount === 1) updatedOrders++
            }
        }
        console.log(`${updatedOrders} orders updated from ${ordersToUpdate.length}`)

        //read and process new, paid and unpaid orders
        const dbQuery = { vyrizeno : { $in: ['c','d','n','g'] } }
        const dbOptions = { sort: {'id_order': -1} }
        const ordersSelection = await ordersCollection.find(dbQuery, dbOptions).toArray()
        console.log(ordersSelection.length)
        for (orderIndex=0; orderIndex < ordersSelection.length; orderIndex++) {
            console.log('1')
            const order = ordersSelection[orderIndex]
            let status = ''
            let toSend = false
            if (order.gateway_payment_state && order.gateway_payment_state != "paid") status='Ne'
            if (order.payment.nazev_platba == "Platba předem na účet" 
                && (order.vyrizeno != "c" || order.vyrizeno != "g")) status='Ne'
            if (order.gateway_payment_state == "paid" || order.vyrizeno == "c") status='Ano'
            if (order.delivery.nazev_postovne == "Osobní odběr" 
                && order.payment.nazev_platba == "Platba předem na účet" 
                && order.vyrizeno == "g") status='Ano'
            if (order.payment.nazev_platba == "Platba dobírkou" || status=='Ano') toSend = true

            //Collect PPL data
            let adress = order.customer.delivery_information.street
            adress.trim()
            let adrArr = adress.split(' ')
            let dom = adrArr.pop()
            adress = adrArr.join(' ')
            let phone = order.customer.delivery_information.phone
            if (phone.length !== 9) {
                phone = phone.slice(phone.length - 9, phone.length)}
            let dobirka = ''
            if (order.payment.nazev_platba == "Platba dobírkou") {
                dobirka = order.total_per_vat['21'].price_with_vat
            }
            let pplData = {
                'vs': order.number,
                'poznamka': order.customer.delivery_information.note,
                'osoba': order.customer.delivery_information.name,
                'telefon': phone,
                'email': order.customer.delivery_information.email,
                'ulice': adress,
                'dom': dom,
                'mesto': order.customer.delivery_information.city,
                'psc': order.customer.delivery_information.zip,
                'dobirka': dobirka,
            }
            
            //productlist + assign stores and action 'n' or 'u'
            for (i=0; i<order.row_list.length; i++) {
                const product = order.row_list[i]
                let productId = product.product_number
                let size = product.variant_description.split(' ')[2]
                if (typeof(size) == "number" ) {size = size.toString()}
                
                //temporary solution to check more then one same item in orders
                let itemQuantity = 1
                let backwCounter = productList.length - 1
                console.log('2')
                while (backwCounter >= 0 ) {
                    let prevItem = productList[backwCounter]
                    if (productId === prevItem.productId && size === prevItem.size) itemQuantity++
                    backwCounter--
                }
                //also some code  at if code below
                let storeID = "Neni"
                let storePrice = 0
                let stock = await inventoryCollection.findOne({ model: productId, size })
                if (stock !== null) {
                    let i=0
                    let founded=false 
                    while (!founded && i < stock.inventory.length) {
                        if (stock.inventory[i].quantity > 0) {
                            if (stock.inventory[i].quantity - itemQuantity >= 0) {
                                founded=true
                                storeID=stock.inventory[i].id
                                storePrice=stock.inventory[i].price
                            } else { itemQuantity = itemQuantity - stock.inventory[i].quantity}
                        }
                        i++
                    }
                } else {storeID = "Nové"}
                let action = 'n'
                let saleDate = ""
                let sold = await salesCollection.findOne({
                    items: {$elemMatch: { 
                        orderId: order.number, 
                        productId,
                        size,
                    }}
                })
                if (sold !== null) { 
                    action = 'u'
                    storeID = sold.storeID
                    saleDate = sold.date.slice(-5)
                }
                console.log('3')
                productList.push({
                    orderId: order.id_order,
                    orderNumber: order.number,
                    productType: product.product_name,
                    productId,
                    size,
                    price: product.price_total_with_vat,
                    count: product.count,
                    sale: toSend,
                    delivery: order.delivery.nazev_postovne.split(' - ')[0],
                    date: saleDate,
                    storeID,
                    action,
                    storePrice,
                })
            }

            //ordersList
            ordersList.push({
                id: order.id_order,
                number: order.number,
                name: order.customer.delivery_information.name,
                delivery: order.delivery.nazev_postovne.split(' - ')[0], 
                payment: order.payment.nazev_platba,
                status,
                date: order.origin.date.date.slice(5,16),
                toSend,
                sender: '',
                pplData
            })
        }
        
        //define sender
        productList.forEach(item => {
            const orderIndex = ordersList.findIndex(order => order.number == item.orderNumber)
            let sender = item.storeID
            if (sender === 'Outlet') sender = 'Harfa'
            if (item.delivery === "Osobní odběr") sender = 'Kotva'
            if (ordersList[orderIndex].sender === ''
                || (ordersList[orderIndex].sender === 'Kotva' && sender === 'Harfa')) 
                { ordersList[orderIndex].sender = sender }
        })

        //add returns to productList
        const returns = returnsCollection.find({'items.saved': false})
        await returns.forEach(ret => {
            ret.items.forEach(item => {
                if (!item.saved) productList.push({
                    ...item,
                    action: 'n',
                    sale: true,
                    ret: true
                })
            })
        })

    } catch(err) {
        console.log('Get orders data error:' + err)
    }
    return { ordersList, productList, }
} 

async function getOrder(orderID) {
    try {
        const order = await ordersCollection.findOne({number: orderID})
        orderData = {
                id: order.id_order,
                number: order.number,
                name: order.customer.delivery_information.name,
                delivery: order.delivery.nazev_postovne.split(' - ')[0],
                deliveryPrice: order.delivery.postovne,
                payment: order.payment.nazev_platba,
                paymentPrice: order.payment.castka_platba,
                date: order.origin.date.date.slice(5,16),
        }
        let items = []
        order.row_list.forEach(product => {
            items.push({
                orderId: order.id_order,
                orderNumber: order.number,
                productType: product.product_name,
                productId: product.product_number,
                size: product.variant_description.split(' ')[2],
                price: product.price_total_with_vat,
                count: product.count,
            })
        })
        for (i=0; i<items.length; i++) {
            let product = items[i]
            let storeID = "Neni"
            let storePrice = 0
            let size = product.size
            if (typeof(size) == "number" ) {size = size.toString()}
            let stock = await inventoryCollection.findOne({
                model: product.productId,
                size: product.size,
            })
            if (stock !== null) {
                let i=0
                let founded=false 
                while (!founded && i < stock.inventory.length) {
                    if (stock.inventory[i].quantity > 0) {
                        founded=true
                        storeID=stock.inventory[i].id
                        storePrice=stock.inventory[i].price
                    }
                    i++
                }
            } else {storeID = "Nové"}
            let sold = await salesCollection.findOne({
                items: {$elemMatch: { 
                    orderId: product.orderNumber, 
                    productId: product.productId,
                    size: product.size,
                }}
            })
            if (sold !== null) { 
                storeID = sold.storeID
                soldItem = sold.items.find(e => (e.productId === product.productId && e.size === product.size ))
                storePrice = soldItem.price
            }
            items[i].storeID = storeID
            items[i].storePrice = storePrice
        }
        orderData.items = items
    } catch(err) {
        console.log('Get order data error:' + err.message)
    }
    return orderData
} 

async function saveReturn(data) {
    if (data.delivery === undefined) { data.delivery = 0 }
    else { data.delivery = data.delivery * -1 }
    if (data.payment === undefined) { data.payment = 0 }
    else { data.payment = data.payment * -1 }
    let date = new Date()
    let newReturn = {
        ...data,
        date: date.toISOString().slice(0,10),
        totalSum: data.delivery + data.payment,
        totalCount: data.items.length * -1,
        datePay: ""
    }
    let sum =0, dif =0
    newReturn.items = data.items.map(item => {
        item.price = item.price * -1
        item.storePrice = item.storePrice * -1
        item.count = item.count * -1 
        item.saved = false
        sum = sum + item.price
        dif = dif +(item.price - item.storePrice)
        return item
    })
    newReturn.totalPriceDif = dif
    newReturn.totalSum = newReturn.totalSum + sum
    try {
        await returnsCollection.insertOne(newReturn)
    } catch(err) {
        console.log('Save return data error:' + err.message)
    }
    return newReturn
} 

async function getReturns() {
    let returns
    try {
        returns = await returnsCollection.find().limit(100).sort({date: -1}).toArray()
    } catch(err) {
        console.log('Get returns data error:' + err.message)
    }
    return {returns}
} 

async function saveSale(items, storeID) {

    //action prepare
    if (storeID === 'Kotva') {
        actionReducer = 0.8
        //const notInAction = ['45101031','45102031','45102501','45121001','45121041','45121042','45122001','45122051','45122591','45246502']
        const inAction = ['45101011','45101031','45101541','45102031','45102501','45102541','45121001','45121041','45121042','45122001','45122051','45122591','47101001','47101002','47101011','47101501','47101502','47101511','47102001','47102002','47102011','47102501','47102511','47102521','47121001','47121011','47121021','47121022','47121023','47121041','47121301','47121511','47121521','47121522','47121523','47121524','47121525','47121531','47121541','47122001','47122011','47122021','47122031','47122041','47122051','47122511','47122521','47122522','47122523','47122524','47122525','47122526','47122531','47122541','47122551','47123011','47126301','47126701','47151001','47151011','47151501','47151511','47151521','47152001','47152011','47152501','47152511','47152521','47181001','47181011','47181501','47181511','47182001','47182011','47182021','47182501','47182511','47182521','47183001','47183011','47183021','47183501','47183511','47183521','47196001','47196051','47196501','47196541','47206001','47206301','47206311','47206501','47206701','47206711','47211001','47211002','47211011','47211021','47211501','47211502','47211503','47211511','47212001','47212002','47212003','47212011','47212021','47212501','47212502','47212503','47212511','47216301','47216701','89121352','89121353','89121731','89121732','89121791','89121792','89122362','89122363','89122381','89122382','89122391','89122392','89122751','89122753','89122821','89122822','89123362','89123363','89123382','89123391','89123392','89123751','89123753','89123821','89123822']
        let actionIndexes = []
        items.forEach((item, index) => {
            let actionItem = false
            //apparel
            if (item.productId.length> 7) // && item.productId[1]<7) //before SS21 
                if (item.productId[1]<7 || inAction.find(i=> i==item.productID) !== undefined) 
                    actionItem = true
            //shoes
            if (item.productId.length === 7 && item.productType !== 'Sandály') actionItem = true
            if (actionItem && item.count>0) actionIndexes.push(index)
        })
        //if (actionIndexes.length > 2) 
        actionIndexes.forEach(index => items[index].storePrice = Math.round(items[index].storePrice * actionReducer))
    }

    let date = new Date().toISOString().slice(0,10)
    let newSale
    try {
        let totalSum = 0
        let totalCount = 0
        let totalPriceDif = 0
        let itemsList = []
        let returnsIndexes = []
        items.forEach((item, index) => {
            if (item.count < 0) returnsIndexes.push(index)
            itemsList.push({
                orderId: item.orderNumber,
                productId: item.productId,
                size: item.size,
                price: item.storePrice,
                count: item.count,
                total: item.count*item.storePrice,
            })
            totalSum = totalSum + item.count*Math.abs(item.storePrice)
            totalCount = totalCount + item.count
            totalPriceDif  = totalPriceDif + item.price - item.storePrice
        })
        newSale = { date, totalSum, totalCount, totalPriceDif, storeID, items: itemsList }
        await salesCollection.insertOne(newSale)

        //update 'saved' status at returns
        for (let i=0; i<returnsIndexes.length; i++) {
            let item = items[returnsIndexes[i]]
            await returnsCollection.updateOne({
                    order: item.orderNumber, 
                    items: {$elemMatch: { productId: item.productId, size: item.size }}},
                { 
                    $set: { "items.$.saved" : true, "items.$.saveDate": date }})
        }
    } catch(err) {
        console.log('Save sale data error:' + err.message)
    }
    return newSale
} 

async function getSales(storeID, date) {
    let sales = []
    let daySalesTotal = 0
    try {
        sales = await salesCollection.find({ date: date, storeID: storeID}).toArray()
        if (sales.length > 0) sales.forEach(sale => {daySalesTotal = daySalesTotal + sale.totalSum})
    } catch(err) {
        console.log('Get sales data error:' + err.message)
    }
    return {salesData : sales, daySales: daySalesTotal, date, id: storeID }
} 

async function getOrdersByItem (item) {
    let orders = []
    try {
        let itemID
        if (item.length == 13) {
            const ean = parseInt(item, 10)
            const variant = await inventoryCollection.findOne({ ean: ean })
            if (variant !== null) itemID=variant["_id"]
        } else {
            const params = item.split('-')
            const model = params[0].toString()
            const size = params[1].toString()
            const variant = await inventoryCollection.findOne({ model: model, size: size })
            if (variant !== null) itemID=variant["_id"]
        }
        if (itemID !== undefined) {
            itemID = itemID.split('_')
            const productID= parseInt(itemID[0], 10)
            const variantID = parseInt(itemID[1], 10)
            const dbQuery = { 
                row_list: {$elemMatch: { 
                    variant_id: variantID, 
                    product_id: productID,
                }}}
            const dbOptions = {projection: {
                '_id': 0,
                'id_order': 1,
                'number': 1,
                'origin': 1,
                'customer': 1,
                'payment': 1,
                'delivery': 1,
                'vyrizeno': 1,
            },
            sort: [['id_order', 1]]
          }
            await ordersCollection.find(dbQuery, dbOptions).forEach(order => {
                const statusVariants = {
                    "n": "Nová",
                    "a": "Vyřízená",
                    "b": "Odeslaná",
                    "c": "Zaplacená",
                    "d": "Přijatá",
                    "e": "Zrušená",
                    "f": "Dobropis",
                    "g": "Osobní odběr",
                  }
                  let status = statusVariants[order.vyrizeno] 
                  orders.unshift({
                    number: order.number,
                    name: order.customer.delivery_information.name,
                    delivery: order.delivery.nazev_postovne.split(' - ')[0], 
                    payment: order.payment.nazev_platba,
                    date: order.origin.date.date.slice(0,10),
                    status: status
                  })
            })
        }
    } catch(err) {
        console.log('Get orders data error:' + err.message)
    }
    return { orders }
} 

async function getItem (item) {
    let searchedItem = null
    try {
        if (item.length == 13) {
            const ean = parseInt(item, 10)
            searchedItem = await inventoryCollection.findOne({ ean: ean })
        } else {
            const params = item.split('-')
            const model = params[0].toString()
            const size = params[1].toString()
            searchedItem = await inventoryCollection.findOne({ model: model, size: size })
        }
    } catch(err) {
        console.log('Get item data error:' + err.message)
    }
    return searchedItem
}

var ordersCollection, inventoryCollection, salesCollection, returnsCollection

function init (mongoUri) {
    const mongoClient = new MongoClient(mongoUri, { useUnifiedTopology: true })
    if (mongoClient.isConnected() === false) {
        mongoClient.connect().then(() => {
            console.log('Connected to DB')
            const db = mongoClient.db('pmg')
            ordersCollection = db.collection('orders')
            inventoryCollection = db.collection('variants')
            salesCollection = db.collection('sales')
            returnsCollection = db.collection('returns')
        })
    }
    return {
        getOrdersData, saveSale, saveReturn, getReturns, getSales, getOrdersByItem, getOrder, getItem
    }
}

module.exports = { init }