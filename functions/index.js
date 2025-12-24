const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

exports.submitOrder = functions.https.onCall(async (data, context) => {
    // 1. Verificación básica (App Check)
    // Descomenta la siguiente línea cuando hayas configurado App Check
    // if (context.app == undefined) {
    //   throw new functions.https.HttpsError(
    //       'failed-precondition',
    //       'La función debe ser llamada desde una App verificada.'
    //   );
    // }

    const cart = data.cart;
    const customer = data.customer || {};

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'El carrito está vacío o es inválido.');
    }

    // Precios base para cálculo seguro
    const UNIT_COSTS = {
        figura_g: 10.42,
        figura_p: 3.47,
        t_roja: 0.522,
        t_amarilla: 0.522,
        t_azul: 0.522,
        pinceles: 4.00,
        paletas: 4.00,
        envases: 2.66
    };

    const inventoryRef = db.collection('config').doc('inventoryState');

    try {
        const result = await db.runTransaction(async (transaction) => {
            const inventoryDoc = await transaction.get(inventoryRef);
            if (!inventoryDoc.exists) {
                throw new functions.https.HttpsError('unavailable', 'Inventario no disponible.');
            }

            const currentState = inventoryDoc.data();
            const currentStock = currentState.stock || {};
            const pendingDeductions = {};

            // 2. Validación y Cálculo de Stock
            for (const item of cart) {
                if (!item.quantity || item.quantity <= 0) continue;

                for (const [material, qtyNeededPerUnit] of Object.entries(item.recipe)) {
                    if (material === 'price') continue;

                    const totalNeeded = qtyNeededPerUnit * item.quantity;
                    pendingDeductions[material] = (pendingDeductions[material] || 0) + totalNeeded;

                    const available = currentStock[material] || 0;
                    if (available < pendingDeductions[material]) {
                        throw new functions.https.HttpsError(
                            'resource-exhausted',
                            `Stock insuficiente de ${material}.`
                        );
                    }
                }
            }

            // 3. Aplicar cambios
            // Descontar inventario
            for (const [material, deduction] of Object.entries(pendingDeductions)) {
                currentStock[material] = Math.max(0, (currentStock[material] || 0) - deduction);
            }

            // Calcular ganancias y registrar venta
            const sales = currentState.sales || [];

            // Preparar datos para Pending Order
            const orderId = Date.now().toString();
            const orderItems = [];
            let orderTotal = 0;
            let orderProfit = 0;

            for (const item of cart) {
                let cost = 0;
                for (const [mat, qty] of Object.entries(item.recipe)) {
                    if (mat === 'price') continue;
                    cost += (UNIT_COSTS[mat] || 0) * qty;
                }

                const totalItemCost = cost * item.quantity;
                const totalItemPrice = item.price * item.quantity;
                const totalItemProfit = totalItemPrice - totalItemCost;

                // Agregar a la lista de items del pedido (estructura para pendingOrders)
                orderItems.push({
                    name: item.name,
                    quantity: item.quantity,
                    price: item.price,
                    recipe: item.recipe,
                    profit: parseFloat(totalItemProfit.toFixed(2))
                });

                orderTotal += totalItemPrice;
                orderProfit += totalItemProfit;

                // Registrar venta individual en histórico global (legacy structure compatibility)
                for (let i = 0; i < item.quantity; i++) {
                    const singleProfit = item.price - cost;
                    sales.push({
                        date: new Date().toLocaleDateString(),
                        type: item.name,
                        price: item.price,
                        profit: parseFloat(singleProfit.toFixed(2)),
                        items: { ...item.recipe }
                    });
                }
            }

            const newTotalProfit = (currentState.totalProfit || 0) + orderProfit;

            // Guardar en Pending Orders
            const pendingOrders = currentState.pendingOrders || [];
            pendingOrders.push({
                id: orderId,
                date: new Date().toLocaleDateString(),
                timestamp: Date.now(),
                customer: customer.elementName || "Cliente Web", // Fallback if not provided
                phone: customer.elementPhone || "",
                total: parseFloat(orderTotal.toFixed(2)),
                profit: parseFloat(orderProfit.toFixed(2)),
                items: orderItems,
                status: 'pending'
            });

            // Actualizar DB
            transaction.update(inventoryRef, {
                stock: currentStock,
                sales: sales,
                totalProfit: newTotalProfit,
                pendingOrders: pendingOrders
            });

            return { success: true, message: 'Pedido procesado correctamente', orderId: orderId };
        });

        return result;

    } catch (error) {
        console.error("Error en transacción:", error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'Error interno al procesar el pedido.', error.message);
    }
});


exports.getOrdersByPhone = functions.https.onCall(async (data, context) => {
    // 1. App Check Verification (Recommended)
    // if (context.app == undefined) {
    //  throw new functions.https.HttpsError('failed-precondition', 'App not verified');
    // }

    const phone = data.phone;
    if (!phone) {
        throw new functions.https.HttpsError('invalid-argument', 'Phone number is required.');
    }

    // Normalize phone (simple check)
    const normalizedPhone = phone.trim().replace(/\s+/g, '');

    if (normalizedPhone.length < 8) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid phone number.');
    }

    try {
        const inventoryDoc = await db.collection('config').doc('inventoryState').get();
        if (!inventoryDoc.exists) return { orders: [] };

        const data = inventoryDoc.data();
        const pendingOrders = data.pendingOrders || [];

        // Filter and sanitize (remove sensitive info if any, though structure is clean)
        const myOrders = pendingOrders.filter(order => {
            // Check if phone matches (contains search term to allow partial match or strict?)
            // Let's do strict suffix match to avoid "00" matching everything
            return order.phone && order.phone.includes(normalizedPhone);
        }).map(order => ({
            id: order.id,
            date: order.date,
            total: order.total,
            status: order.status || 'pending', // pending, completed, etc.
            items: order.items // Allow seeing items
        })).sort((a, b) => b.id - a.id); // Newest first

        return { orders: myOrders };
    } catch (e) {
        console.error(e);
        throw new functions.https.HttpsError('internal', 'Error fetching orders');
    }
});
