// backend/src/functions/shop.js

const { app } = require("@azure/functions");

const { CosmosClient } = require("@azure/cosmos");

const { DefaultAzureCredential } =
    require("@azure/identity");

const { SecretClient } =
    require("@azure/keyvault-secrets");

const {
    BlobServiceClient
} = require("@azure/storage-blob");

const { randomUUID } = require("crypto");


const credential = new DefaultAzureCredential();

const cosmos = new CosmosClient({
    endpoint: process.env.COSMOS_ENDPOINT,
    aadCredentials: credential
});

const database = cosmos.database(
    process.env.COSMOS_DATABASE
);

const productsContainer = database.container("Products");

const ordersContainer = database.container("Orders");

const keyVault = new SecretClient(
    process.env.KEY_VAULT_URL,
    credential
);

const blobService = new BlobServiceClient(
    `https://${process.env.STORAGE_ACCOUNT}.blob.core.windows.net`,
    credential
);

const imagesContainer =
    blobService.getContainerClient("product-images");


// Generate image URLs from Azure Blob Storage

function getImageUrls(imageNames = []) {

    return imageNames.map(name => {

        const blob = imagesContainer.getBlobClient(name);

        return blob.url;

    });

}


// Retrieve products

async function findProducts(ids) {

    if (!ids.length) return [];

    const uniqueIds = [...new Set(ids)];

    const query = {
        query: "SELECT * FROM c WHERE ARRAY_CONTAINS(@ids, c.id)",
        parameters: [
            {
                name: "@ids",
                value: uniqueIds
            }
        ]
    };

    const { resources } =
        await productsContainer.items
            .query(query)
            .fetchAll();

    return resources;
}


// 1. GET ALL PRODUCTS

app.http("getProducts", {

    methods: ["GET"],

    authLevel: "function",

    route: "products",

    handler: async (request, context) => {

        try {

            context.log("Products API triggered");

            const query = {
                query: `
                    SELECT * FROM c
                    WHERE c.active = true
                `
            };

            const { resources } =
                await productsContainer.items
                    .query(query)
                    .fetchAll();

            const products = resources.map(product => ({

                id: product.id,

                name: product.name,

                category: product.category,

                price: product.price,

                stock: product.stock,

                description: product.description,

                images: getImageUrls(product.images)

            }));

            return {

                status: 200,

                headers: {
                    "Cache-Control": "no-store"
                },

                jsonBody: {
                    success: true,
                    count: products.length,
                    products
                }

            };

        } catch (error) {

            context.error("Products error", error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: "Unable to load products"
                }
            };

        }

    }

});


// 2. GET PRODUCT DETAILS AND MULTIPLE IMAGES

app.http("getProductDetails", {

    methods: ["GET"],

    authLevel: "function",

    route: "products/{id}",

    handler: async (request, context) => {

        try {

            const id = request.params.id;

            const query = {
                query: "SELECT * FROM c WHERE c.id = @id",
                parameters: [
                    {
                        name: "@id",
                        value: id
                    }
                ]
            };

            const { resources } =
                await productsContainer.items
                    .query(query)
                    .fetchAll();

            const product = resources[0];

            if (!product || product.active !== true) {

                return {
                    status: 404,
                    jsonBody: {
                        success: false,
                        message: "Product not found"
                    }
                };

            }

            return {

                status: 200,

                jsonBody: {

                    success: true,

                    product: {

                        id: product.id,

                        name: product.name,

                        category: product.category,

                        price: product.price,

                        stock: product.stock,

                        description: product.description,

                        specifications:
                            product.specifications || {},

                        images: getImageUrls(
                            product.images
                        )

                    }

                }

            };

        } catch (error) {

            context.error("Product detail error", error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: "Unable to retrieve product"
                }
            };

        }

    }

});


// 3. CART PRICE VALIDATION

app.http("cartQuote", {

    methods: ["POST"],

    authLevel: "function",

    route: "cart/quote",

    handler: async (request, context) => {

        try {

            const body = await request.json();

            const items = body.items;

            if (
                !Array.isArray(items) ||
                items.length === 0 ||
                items.length > 50
            ) {

                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: "Invalid cart items"
                    }
                };

            }

            const valid = items.every(item =>
                typeof item.productId === "string" &&
                Number.isInteger(item.quantity) &&
                item.quantity >= 1 &&
                item.quantity <= 100
            );

            if (!valid) {

                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: "Invalid product quantity"
                    }
                };

            }

            const ids = items.map(
                item => item.productId
            );

            const products = await findProducts(ids);

            const productMap = new Map(
                products.map(product => [product.id, product])
            );

            const result = [];

            let total = 0;

            for (const item of items) {

                const product =
                    productMap.get(item.productId);

                if (!product || product.active !== true) {

                    return {
                        status: 404,
                        jsonBody: {
                            success: false,
                            message: "Product not available"
                        }
                    };

                }

                if (product.stock < item.quantity) {

                    return {
                        status: 409,
                        jsonBody: {
                            success: false,
                            message: `Insufficient stock for ${product.name}`
                        }
                    };

                }

                const lineTotal =
                    product.price * item.quantity;

                total += lineTotal;

                result.push({

                    productId: product.id,

                    name: product.name,

                    price: product.price,

                    quantity: item.quantity,

                    lineTotal

                });

            }

            return {

                status: 200,

                jsonBody: {

                    success: true,

                    items: result,

                    total,

                    currency: "INR"

                }

            };

        } catch (error) {

            context.error("Cart error", error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: "Unable to calculate cart"
                }
            };

        }

    }

});


// 4. CREATE ORDER

app.http("createOrder", {

    methods: ["POST"],

    authLevel: "function",

    route: "orders",

    handler: async (request, context) => {

        try {

            const body = await request.json();

            const { customer, items } = body;

            if (
                !customer ||
                typeof customer.name !== "string" ||
                typeof customer.email !== "string" ||
                typeof customer.phone !== "string" ||
                typeof customer.address !== "string" ||
                customer.name.length > 100 ||
                customer.email.length > 254 ||
                customer.phone.length > 20 ||
                customer.address.length > 500 ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) ||
                !/^[0-9+()\-\s]{7,20}$/.test(customer.phone) ||
                !Array.isArray(items) ||
                items.length === 0 ||
                items.length > 50
            ) {

                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: "Invalid checkout details"
                    }
                };

            }

            const valid = items.every(item =>
                typeof item.productId === "string" &&
                Number.isInteger(item.quantity) &&
                item.quantity >= 1 &&
                item.quantity <= 100
            );

            if (!valid) {

                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: "Invalid order items"
                    }
                };

            }

            // Always retrieve prices and stock from Cosmos DB.
            // Never trust frontend cart prices.

            const products = await findProducts(
                items.map(item => item.productId)
            );

            const productMap = new Map(
                products.map(product => [product.id, product])
            );

            const orderItems = [];

            let total = 0;

            for (const item of items) {

                const product =
                    productMap.get(item.productId);

                if (!product || product.active !== true) {

                    return {
                        status: 409,
                        jsonBody: {
                            success: false,
                            message: "Product unavailable"
                        }
                    };

                }

                if (product.stock < item.quantity) {

                    return {
                        status: 409,
                        jsonBody: {
                            success: false,
                            message: `Insufficient stock: ${product.name}`
                        }
                    };

                }

                const lineTotal =
                    product.price * item.quantity;

                total += lineTotal;

                orderItems.push({

                    productId: product.id,

                    name: product.name,

                    price: product.price,

                    quantity: item.quantity,

                    lineTotal

                });

            }

            // Create pending-payment order.
            // Payment and stock reservation are separate workflows.

            const orderId = randomUUID();

            const order = {

                id: orderId,

                customer: {

                    name: customer.name,

                    email: customer.email,

                    phone: customer.phone,

                    address: customer.address

                },

                items: orderItems,

                total,

                currency: "INR",

                orderStatus: "PendingPayment",

                paymentStatus: "NotPaid",

                createdAt: new Date().toISOString()

            };

            await ordersContainer.items.create(order);

            context.log("Order created", orderId);

            return {

                status: 201,

                jsonBody: {

                    success: true,

                    message: "Order created successfully",

                    orderId,

                    total,

                    currency: "INR",

                    orderStatus: "PendingPayment",

                    paymentStatus: "NotPaid"

                }

            };

        } catch (error) {

            context.error("Order error", error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: "Unable to create order"
                }
            };

        }

    }

});


// 5. GET ORDER STATUS

app.http("getOrder", {

    methods: ["GET"],

    authLevel: "function",

    route: "orders/{id}",

    handler: async (request, context) => {

        try {

            const id = request.params.id;

            const email = request.query.get("email");

            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {

                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: "Valid order email is required"
                    }
                };

            }

            const { resource: order } =
                await ordersContainer
                    .item(id, id)
                    .read();

            if (
                !order ||
                order.customer.email.toLowerCase() !== email.toLowerCase()
            ) {

                return {
                    status: 404,
                    jsonBody: {
                        success: false,
                        message: "Order not found"
                    }
                };

            }

            return {

                status: 200,

                jsonBody: {

                    success: true,

                    orderId: order.id,

                    orderStatus: order.orderStatus,

                    paymentStatus: order.paymentStatus,

                    total: order.total,

                    currency: order.currency,

                    createdAt: order.createdAt

                }

            };

        } catch (error) {

            if (error.code === 404) {

                return {
                    status: 404,
                    jsonBody: {
                        success: false,
                        message: "Order not found"
                    }
                };

            }

            context.error("Order lookup error", error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: "Unable to retrieve order"
                }
            };

        }

    }

});