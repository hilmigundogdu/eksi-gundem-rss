# Ekşi'nin mobil API'sine (api.eksisozluk.com) köprü; gundem.mjs bunu alt süreç olarak açar.
# stdin'den satır başına bir istek ({"id", "path"}) okur, stdout'a satır başına bir yanıt yazar:
# {"id", "status", "json"} ya da {"id", "error"}.
# Kimlik, Android uygulamasının anonim token akışıyla alınır. Cloudflare TLS imzasına baktığından
# istekler curl_cffi ile Chrome'unkine benzer bir imzayla gider.
import base64, json, random, sys, uuid
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding
from curl_cffi import requests

API = 'https://api.eksisozluk.com'
# Uygulamaya gömülü açık anahtar (DER, SubjectPublicKeyInfo); Api-Secret bununla şifrelenir.
KEY = serialization.load_der_public_key(base64.b64decode('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4cNO1MGajB7fTxuZ1bC+lSwMuob7YgTH441nWgTA+BDlw5bdYGyAIrTCkaSLrwimgG5rHT2izPqzn1rGRoqmOV2VwIMkTF0FwmZ+STDu09zF2y7y7/OkZ9FaNOQTBDoCS1t2z38WC6YwzA4b/GTrc/FFfMnVw4GPgIWlsxkNYMIspbtLEWcQGaa76e1nGPWxKgN0vF6T2lvhJaHnva9sLa9v+V2gcIlELF2KyIbNaN0zoy0bna7Mh1FA8Z/8BFPH2aIIdvvhIycZHcISZdsd8giHsXSYkZlOqP7JS8ChKgWUccPNQlI+n7NbxmIGIFfWPXFIOc5sWbNQ+RtrLYrJowIDAQAB'))
APP_UUID, BUILD, VERSION = 'c8ecd738-dc33-45a4-a977-ae8e2a51c644', 144, '2.4.10'
AGENT = f'eksisozluk-android/{BUILD}'
TIMEOUT = 30

session = requests.Session(impersonate='chrome')
session.headers.update({'User-Agent': AGENT, 'Accept': 'application/json'})


def api_secret(server_ms, client_secret):
    # Sunucu saatinden rastgele gün/saat/dakika düşülür, sunucu aynı farkları ekleyip saati denetler.
    day, hour, minute = random.randint(1, 5000), random.randint(1, 5000), random.randint(1, 10000)
    noise = ''.join(uuid.uuid4().hex for _ in range(3))[:random.randint(40, 80)]
    shifted = server_ms - day * 86_400_000 - hour * 3_600_000 - minute * 60_000
    plain = f'{noise}-{APP_UUID}-{len(noise) ** 2}-{shifted}-{day}-{hour}-{minute}-{AGENT}-{client_secret}'
    return base64.b64encode(KEY.encrypt(plain.encode(), padding.PKCS1v15())).decode()


def login():
    session.headers.pop('Authorization', None)
    r = session.get(API + '/v2/clientsettings/time', timeout=TIMEOUT)
    r.raise_for_status()
    secret = str(uuid.uuid4())
    session.headers['Client-Secret'] = secret
    r = session.post(API + '/v2/account/anonymoustoken', timeout=TIMEOUT, data={
        'DeviceModel': 'Google sdk_gphone_x86_64', 'Platform': 'g', 'Version': VERSION, 'Build': BUILD,
        'Api-Secret': api_secret(int(r.json()['Data']), secret), 'Client-Secret': secret,
        'ClientUniqueId': str(uuid.uuid4())})
    r.raise_for_status()
    data = r.json().get('Data') or {}
    token = data.get('access_token') or data.get('AccessToken')
    if not token:
        raise RuntimeError('anonim token alınamadı: ' + r.text[:200])
    session.headers['Authorization'] = f'Bearer {token}'


def get(path):
    if 'Authorization' not in session.headers:
        login()
    r = session.get(API + path, timeout=TIMEOUT)
    if r.status_code == 401:  # token süresi doldu (24 saat) ya da geçersiz
        login()
        r = session.get(API + path, timeout=TIMEOUT)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, None


def main():
    for line in sys.stdin:
        req = json.loads(line)
        try:
            status, body = get(req['path'])
            out = {'id': req['id'], 'status': status, 'json': body}
        except Exception as e:  # ağ ya da kimlik hatası: istek düşer, köprü yaşar
            out = {'id': req['id'], 'error': f'{type(e).__name__}: {e}'}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
