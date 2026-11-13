// Source-launched by Gradle with the same Marketplace ZIP Signer used by verifyPluginSignature.
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.regex.Pattern;
import org.jetbrains.zip.signer.verifier.SuccessfulVerificationResult;
import org.jetbrains.zip.signer.verifier.ZipVerifier;

class VerifyPluginAuthor {
    public static void main(String[] args) throws Exception {
        var factory = CertificateFactory.getInstance("X.509");
        var chain = new ArrayList<X509Certificate>();
        var text = Files.readString(Path.of(args[1])).strip();
        var block = Pattern.compile("-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\\s]+-----END CERTIFICATE-----");
        while (!text.isEmpty()) {
            var match = block.matcher(text);
            if (!match.lookingAt()) {
                throw new IllegalArgumentException("Invalid signing certificate PEM chain");
            }
            var pem = match.group().getBytes(StandardCharsets.US_ASCII);
            chain.add((X509Certificate) factory.generateCertificate(new ByteArrayInputStream(pem)));
            text = text.substring(match.end()).stripLeading();
        }
        if (chain.isEmpty()) {
            throw new IllegalArgumentException("Empty signing certificate chain");
        }
        for (int i = 1; i < chain.size(); i++) {
            var child = chain.get(i - 1);
            var issuer = chain.get(i);
            if (!child.getIssuerX500Principal().equals(issuer.getSubjectX500Principal())) {
                throw new IllegalArgumentException("Signing certificate chain must be leaf-first");
            }
            child.verify(issuer.getPublicKey());
        }
        var result = ZipVerifier.verify(Path.of(args[0]));
        if (!(result instanceof SuccessfulVerificationResult verified)
                || !verified.getCertificateChains().contains(chain)) {
            throw new IllegalArgumentException("ZIP signature does not match the configured Ferret author chain");
        }

        var root = Base64.getMimeEncoder(64, new byte[] {'\n'}).encodeToString(chain.getLast().getEncoded());
        Files.writeString(Path.of(args[2]), "-----BEGIN CERTIFICATE-----\n" + root + "\n-----END CERTIFICATE-----\n");
    }
}
