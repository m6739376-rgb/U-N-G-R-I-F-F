const printfulService = exiger('../services/printfulService');
const PayPalService = exiger('../services/paypalService');
const Produit = exiger('../modèles/Produit');
const Commande = exiger('../modèles/Commande');

// Point final de Synchronisation Automatique du Catalogue
exportations.syncPrintful = async (req, res) => {
  essayer {
    const produits bruts = attendre printfulService.getSyncProducts();
    laisser statistiques = { ajouté: 0, mis à jour: 0, erreurs: 0 };

    pour (const production brute de produits bruts) {
      essayer {
        const détails = attendre printfulService.getProductDetails(rawProd.id);
        const syncProduct = détails.sync_product;
        const syncVariants = détails.sync_variants;

        const variantsData = syncVariants.map(v.v => ({
          syncVariantId: v.id,
          nom: v.nom,
          lab: v.sku,
          prix: v.prix_de détail,
          couleur: v.couleur,
          taille: v.taille,
          image: v.files.find(ff => f.type === « aperçu »)?.preview_url || syncProduct.thumbnail_url
        }));

        attendre Produit.findOneAndUpdate(
          { printfulId: syncProduct.id },
          {
            nom: syncProduct.name,
            printfulId: syncProduct.id,
            vignette: syncProduct.thumbnail_url,
            variantes: variantesDonnées,
            mis à jourAt: Date.maintenant()
          },
          { upsert: vrai, nouveau: vrai }
        );
        statistiques.mis à jour++;
      } attraper (err) {
        statistiques.erreurs++;
      }
    }

    res.json({ succès: vrai, message: 'Synchronisation Printful réussie', statistiques });
  } attraper (erreur) {
    res.status(500).json({ succès: faux, message: erreur.message });
  }
};

// Client Processus Complet de Commande
exportations.processCheckout = async (req, res) => {
  const { paypalOrderId, cartItems, shippingAddress, userId } = req.body;

  essayer {
    // 1. Capture du paiement PayPal
    const captureRésultat = attendre paypalService.captureOrder(paypalOrderId);
    
    si (captureResult.status !== 'TERMINÉ') {
      retour res.status(400).json({ succès: faux, erreur: ‘Paiement non validé’ });
    }

    // 2. Inscription initiale dans UNGRIFF
    const ordre non griff = nouveau Ordre({
      utilisateur: identifiant utilisateur || null,
      items: articles de panier,
      montant total: captureResult.purchase_units[0].paiements.captures[0].montant.valeur,
      adresse de livraison,
      statut de paiement: 'PAYÉ',
      PayPalOrderId: paypalOrderId,
      statut d'impression: 'EN ATTENTE'
    });
    attendre ungriffOrder.save();

    // 3. Transmission automatique à Imprimer
    essayer {
      const commande imprimée = attendre printfulService.createOrder({
        adresse de livraison,
        items: articles de panier
      });

      ungriffOrder.printfulOrderId = printfulOrder.id;
      ungriffOrder.printfulStatus = printfulOrder.status;
      attendre ungriffOrder.save();

    } attraper (pfErr) {
      console.erreur(« Paiement reçu mais échec de transmission Imprimé : », pfErr);
      ungriffOrder.printfulStatus = 'ÉCHEC_BESOINS_RÉVISION_MANUELLE';
      attendre ungriffOrder.save();
    }

    res.json({
      succès: vrai,
      ID de commande: ungriffOrder._id,
      suiviUrl: null,
      message: 'Commande inscrite et transmise à l\'atelier'
    });

  } attraper (erreur) {
    res.status(500).json({ succès: faux, erreur: erreur.message });
  }
};
