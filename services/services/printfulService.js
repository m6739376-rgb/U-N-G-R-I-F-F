const axios = exiger('axios');

classe Service d'impression {
  constructeur() {
    cette.apiKey = process.env.PRINTFUL_API_KEY;
    cette.storeId = process.env.PRINTFUL_STORE_ID;
    cette.client = axios.create({
      baseURL: 'https://api.printful.com/',
      en-têtes: {
        « Autorisation »: `Porteur ${cette.apiKey}`,
        « ID du magasin X-PF »: cette.storeId || '',
        « Type de contenu »: 'application/json'
      }
    });
  }

  //Récupérateur tous les produits du catalogue Imprimé
  async getSyncProduits() {
    essayer {
      const réponse = attendre cette.client.get('magasin/produits');
      retour réponse.données.résultat;
    } attraper (erreur) {
      console.erreur(‘Erreur lors de la réunion des produits Imprimé :’, erreur.réponse?.données || erreur.message);
      lancer nouveau Erreur(« Impossible de contacter Printful »);
    }
  }

  //Obtenir les détails complets d'un produit (variantes, prix, images)
  async obtenir les détails du produit(ID du produit) {
    essayer {
      const réponse = attendre cette.client.get(`magasin/produits/${productId}`);
      retour réponse.données.résultat;
    } attraper (erreur) {
      console.erreur(`Erreur détail produit ${productId}:`, erreur.réponse?.données || erreur.message);
      lancer erreur;
    }
  }

  // Transmettre une commande à Imprimer pour impression et édition
  async créer une commande(données de commande) {
    essayer {
      const charge utile = {
        destinataire: {
          nom: orderData.shippingAddress.name,
          adresse1: orderData.shippingAddress.address1,
          ville: orderData.shippingAddress.city,
          état_code: orderData.shippingAddress.stateCode || '',
          code_pays: orderData.shippingAddress.countryCode,
          zip: orderData.shippingAddress.zip
        },
        items: orderData.items.map(item => ({
          sync_variant_id: élément.syncVariantId,
          quantité: élément.quantité,
          prix de détail_: article.prix
        }))
      };

      const réponse = attendre cette.client.post('ordres', charge utile);
      retour réponse.données.résultat;
    } attraper (erreur) {
      console.erreur(‘Erreur création commande Imprimé :’, erreur.réponse?.données || erreur.message);
      lancer erreur;
    }
  }
}

module.exportations = nouveau PrintfulService();
