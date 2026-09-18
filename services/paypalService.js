const checkoutNodeJssdk = exiger('@paypal/checkout-server-sdk');

fonction environnement() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  si (process.env.PAYPAL_MODE === 'vivre') {
    retour nouveau checkoutNodeJssdk.core.LiveEnvironment(clientId, clientSecret);
  } autre {
    retour nouveau checkoutNodeJssdk.core.SandboxEnvironment(clientId, clientSecret);
  }
}

fonction client() {
  retour nouveau checkoutNodeJssdk.core.PayPalHttpClient(environnement());
}

//Création de l'ordre de paiement
async fonction créer une commande(totalMontant, devise = 'EUR') {
  const demande = nouveau checkoutNodeJssdk.orders.OrdersCreateRequest();
  demande.préférer("retour=représentation");
  requête.requestBody({
    intention: 'CAPTURE',
    acheter_unités: [{
      montant: {
        code_monnaie: devise,
        valeur: totalAmount.toFixed(2)
      }
    }]
  });

  const réponse = attendre client().exécuter(requête);
  retour réponse.données;
}

// Validation et capture des fonds
async fonction captureOrder(ID de commande) {
  const demande = nouveau checkoutNodeJssdk.orders.OrdersCaptureRequest(orderId);
  requête.requestBody({});

  const réponse = attendre client().exécuter(requête);
  retour réponse.données;
}

module.exports = { créerOrder, captureOrder };
